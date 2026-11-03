#!/usr/bin/env python3
"""Trusted main-branch promotion; never check out or execute the built branch."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

GUARD = "Protect staging manifests"
WORKFLOW = ".github/workflows/images.yml"


class ApiError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class GitHub:
    def __init__(self, repository, token):
        self.root = os.environ.get("GITHUB_API_URL", "https://api.github.com") + "/repos/" + repository
        self.token = token

    def request(self, path, data=None, method=None):
        request = Request(self.root + "/" + path,
                          data=json.dumps(data).encode() if data is not None else None,
                          method=method, headers={
                              "Authorization": "Bearer " + self.token,
                              "Accept": "application/vnd.github+json",
                              "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with urlopen(request, timeout=60) as response:
                body = response.read()
                return json.loads(body) if body else None
        except HTTPError as error:
            body = json.loads(error.read())
            raise ApiError(error.code, body.get("message", "GitHub API error")) from error


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def protected(path):
    return path == "gitops/staging" or path.startswith("gitops/staging/")


def forbidden_pr_changes(branch, files):
    paths = [p for f in files for p in [f["filename"], f.get("previous_filename", f["filename"])]]
    # Explicit infrastructure PRs may change GitOps configuration, without app code.
    if branch.startswith("gitops/") and paths and all(p.startswith("gitops/") for p in paths):
        return []
    return sorted({p for p in paths if protected(p)})


def eligible(run, repository):
    return (run.get("conclusion") == "success"
            and run.get("event") in ("push", "workflow_dispatch")
            and bool(run.get("head_branch"))
            and run.get("head_branch") != "main"
            and not run.get("head_branch", "").startswith("gitops/")
            and (run.get("head_repository") or {}).get("full_name") == repository
            and run.get("path", "").split("@")[0] == WORKFLOW)


def newer(run, state):
    return (run["run_number"], run["run_attempt"]) > (state.get("run_number", 0), state.get("run_attempt", 0))


def replace_revision(text, version):
    result, count = re.subn(r"(?m)^(\s*targetRevision:)\s*[^\n]+$", lambda m: m[1] + " " + version, text)
    if count != 1:
        raise ValueError("Expected exactly one chart targetRevision in each Application")
    return result


def branch_changes(main, source):
    base = git("merge-base", main, source)
    return git("diff", "--name-only", base, source, "--", "gitops/staging")


def guard(api, event):
    number = event["pull_request"]["number"]
    files = []
    page = 1
    while True:
        batch = api.request(f"pulls/{number}/files?per_page=100&page={page}")
        files.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    bad = forbidden_pr_changes(event["pull_request"]["head"]["ref"], files)
    if bad:
        raise SystemExit("Feature PRs must not change gitops/staging: " + ", ".join(bad)
                         + ". Restore those paths from the branch merge-base, or use a separate gitops/* configuration PR.")
    print("PR preserves the staging manifests maintained on main.")


def promote(api, repository, run_id):
    run = api.request(f"actions/runs/{int(run_id)}")
    if not eligible(run, repository):
        print("Skipping: not a successful same-repository feature build.")
        return
    source = run["head_sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("Invalid source SHA")
    config = json.loads(Path("scripts/staging-config.json").read_text())
    # A failed-jobs-only rerun may leave charts from different attempts.
    # Require all publishers to have succeeded in this exact attempt.
    jobs = []
    page = 1
    while True:
        batch = api.request(f"actions/runs/{int(run_id)}/attempts/{run['run_attempt']}/jobs?per_page=100&page={page}")["jobs"]
        jobs.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    published = {j["name"] for j in jobs if j["conclusion"] == "success" and j.get("run_attempt", run["run_attempt"]) == run["run_attempt"]}
    if not set(config["publish_jobs"]).issubset(published):
        raise SystemExit("Not all charts were published in the same run attempt. Re-run ALL build jobs, not only failed jobs.")
    version = f"0.1.0-ci.{run['run_number']}.{run['run_attempt']}"
    for attempt in range(5):
        try:
            branch = api.request("git/ref/heads/" + quote(run["head_branch"], safe="/"))
        except ApiError as error:
            if error.status == 404:
                print("Skipping: source branch was deleted.")
                return
            raise
        if branch["object"]["sha"] != source:
            print("Skipping: a newer commit exists on the source branch.")
            return
        main = api.request("git/ref/heads/main")["object"]["sha"]
        subprocess.run(["git", "fetch", "--no-tags", "origin", main, source], check=True, capture_output=True)
        if branch_changes(main, source):
            raise SystemExit("Refusing a feature build that changes gitops/staging; main owns deployment state.")
        state_path = "gitops/staging/.release.json"
        state_text = subprocess.run(["git", "show", main + ":" + state_path], capture_output=True, text=True)
        state = json.loads(state_text.stdout) if state_text.returncode == 0 else {}
        if not newer(run, state):
            print("Skipping: this build is already promoted or older than the current staging release.")
            return
        entries = []
        for component in config["components"]:
            path = f"gitops/staging/{component}.yaml"
            text = git("show", main + ":" + path) + "\n"
            entries.append({"path": path, "mode": "100644", "type": "blob",
                            "content": replace_revision(text, version)})
        state = {key: run[key] for key in ("id", "run_number", "run_attempt", "head_sha", "head_branch", "html_url")}
        state["version"] = version
        entries.append({"path": state_path, "mode": "100644", "type": "blob",
                        "content": json.dumps(state, indent=2) + "\n"})
        base_tree = api.request("git/commits/" + main)["tree"]["sha"]
        tree = api.request("git/trees", {"base_tree": base_tree, "tree": entries})
        commit = api.request("git/commits", {
            "message": f"chore(staging): promote {config['project']} {version}\n\nSource: {run['head_branch']} @ {source}\nBuild: {run['html_url']}",
            "tree": tree["sha"], "parents": [main]})
        # The same required check is satisfied for this trusted GitOps-only commit.
        # This allows main protection without a PAT or a branch-protection bypass.
        api.request("check-runs", {"name": GUARD, "head_sha": commit["sha"],
                    "status": "completed", "conclusion": "success",
                    "output": {"title": "Trusted staging promotion",
                               "summary": "Only chart versions and release provenance in gitops/staging were changed; application code and configuration were preserved."}})
        try:
            api.request("git/refs/heads/main", {"sha": commit["sha"], "force": False}, method="PATCH")
        except ApiError as error:
            if error.status in (409, 422) and api.request("git/ref/heads/main")["object"]["sha"] != main:
                time.sleep(attempt + 1)
                continue
            raise
        print(f"Promoted {version} to main at {commit['sha']}")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"Promoted **{version}** from `{run['head_branch']}` (`{source}`) to `main`. Argo CD will reconcile this commit.\n")
        return
    raise SystemExit("main kept changing; promotion did not overwrite concurrent changes. Re-run this workflow.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["guard", "promote"])
    parser.add_argument("--run-id", type=int)
    args = parser.parse_args()
    repository = os.environ["GITHUB_REPOSITORY"]
    api = GitHub(repository, os.environ["GH_TOKEN"])
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if args.command == "guard":
        guard(api, event)
    else:
        run_id = args.run_id or (event.get("workflow_run") or {}).get("id")
        if not run_id:
            raise SystemExit("A completed build run ID is required")
        promote(api, repository, run_id)


if __name__ == "__main__":
    main()

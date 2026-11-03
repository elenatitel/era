import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("delivery", Path(__file__).resolve().parents[1] / "staging_delivery.py")
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryTests(unittest.TestCase):
    def run_info(self, **changes):
        return {"conclusion": "success", "event": "push", "head_branch": "feature/new",
                "head_repository": {"full_name": "owner/repo"}, "path": delivery.WORKFLOW,
                "run_number": 21, "run_attempt": 2, **changes}

    def test_only_successful_same_repo_feature_builds_are_eligible(self):
        self.assertTrue(delivery.eligible(self.run_info(), "owner/repo"))
        for change in [{"conclusion": "failure"}, {"event": "pull_request"}, {"head_branch": "main"},
                       {"head_repository": {"full_name": "fork/repo"}}, {"path": "other.yml"},
                       {"head_branch": "gitops/config"}]:
            self.assertFalse(delivery.eligible(self.run_info(**change), "owner/repo"))
        self.assertTrue(delivery.eligible(self.run_info(event="workflow_dispatch"), "owner/repo"))

    def test_numeric_release_order_and_attempts(self):
        self.assertTrue(delivery.newer(self.run_info(), {"run_number": 9, "run_attempt": 10}))
        self.assertTrue(delivery.newer(self.run_info(), {"run_number": 21, "run_attempt": 1}))
        self.assertFalse(delivery.newer(self.run_info(), {"run_number": 21, "run_attempt": 2}))
        self.assertFalse(delivery.newer(self.run_info(), {"run_number": 22, "run_attempt": 1}))

    def test_promotion_preserves_configuration(self):
        original = "spec:\n  source:\n    targetRevision: 0.1.0-ci.9.1\n    helm:\n      values: custom\n"
        expected = original.replace("0.1.0-ci.9.1", "0.1.0-ci.21.2")
        self.assertEqual(delivery.replace_revision(original, "0.1.0-ci.21.2"), expected)
        for bad in ["no revision", original + "targetRevision: other\n"]:
            with self.assertRaises(ValueError):
                delivery.replace_revision(bad, "0.1.0-ci.21.2")

    def test_guard_catches_changes_deletions_and_renames(self):
        for f in [{"filename": "gitops/staging/api.yaml"},
                  {"filename": "docs/old.yaml", "previous_filename": "gitops/staging/api.yaml"},
                  {"filename": "gitops/staging/.release.json", "status": "removed"}]:
            self.assertTrue(delivery.forbidden_pr_changes("feature/new", [f]))
        self.assertFalse(delivery.forbidden_pr_changes("feature/new", [{"filename": "apps/api/main.ts"}]))

    def test_intentional_gitops_pr_cannot_include_application_changes(self):
        config = [{"filename": "gitops/staging/api.yaml"}]
        self.assertFalse(delivery.forbidden_pr_changes("gitops/config", config))
        self.assertTrue(delivery.forbidden_pr_changes("gitops/config", config + [{"filename": "apps/main.ts"}]))

    def test_main_promotions_do_not_look_like_feature_changes(self):
        # Reproduce exactly the PR scenario: main advances GitOps after feature branches.
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                def git(*args):
                    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()
                git("init", "-b", "main")
                git("config", "user.email", "test@example.test")
                git("config", "user.name", "Test")
                Path("gitops/staging").mkdir(parents=True)
                path = Path("gitops/staging/app.yaml")
                path.write_text("targetRevision: old\n")
                git("add", ".")
                git("commit", "-m", "initial")
                git("switch", "-c", "feature/new")
                Path("app.txt").write_text("feature\n")
                git("add", ".")
                git("commit", "-m", "feature")
                source = git("rev-parse", "HEAD")
                git("switch", "main")
                path.write_text("targetRevision: new\n")
                git("commit", "-am", "bot promotion")
                main = git("rev-parse", "HEAD")
                self.assertEqual(delivery.branch_changes(main, source), "")
                git("switch", "feature/new")
                path.write_text("targetRevision: accidental\n")
                git("commit", "-am", "accidental overwrite")
                self.assertEqual(delivery.branch_changes(main, git("rev-parse", "HEAD")), str(path))
            finally:
                os.chdir(previous)

class PromotionTests(unittest.TestCase):
    def exercise(self, *, race=False, stale=False, superseded=False, reject_check=False, partial=False):
        from unittest.mock import patch
        source = 'a' * 40
        run = {'id': 42, 'run_number': 21, 'run_attempt': 2, 'head_sha': source,
               'head_branch': 'feature/new', 'head_repository': {'full_name': 'owner/repo'},
               'conclusion': 'success', 'event': 'push', 'path': delivery.WORKFLOW,
               'html_url': 'https://github.com/owner/repo/actions/runs/42'}
        class API:
            main = 'main1'
            trees = []
            checks = []
            updates = []
            def request(self, path, data=None, method=None):
                if path == 'actions/runs/42': return run
                if path.startswith('actions/runs/42/attempts/2/jobs'):
                    names = ['Build api'] if partial else ['Build api','Build web','Publish CloudNativePG database chart']
                    return {'jobs':[{'name':n,'conclusion':'success','run_attempt':2} for n in names]}
                if path == 'git/ref/heads/feature/new': return {'object': {'sha': 'b' * 40 if superseded else source}}
                if path == 'git/ref/heads/main': return {'object': {'sha': self.main}}
                if path.startswith('git/commits/'): return {'tree': {'sha': 'tree-'+self.main}}
                if path == 'git/trees':
                    self.trees.append(data)
                    return {'sha': 'tree'+str(len(self.trees))}
                if path == 'git/commits': return {'sha': 'commit'+str(len(self.trees))}
                if path == 'check-runs':
                    if partial:
                        with self.assertRaises(SystemExit): delivery.promote(api, 'owner/repo', 42)
                    elif reject_check: raise delivery.ApiError(403, 'check creation forbidden')
                    self.checks.append(data)
                    return {}
                if path == 'git/refs/heads/main':
                    if race and self.main == 'main1':
                        self.main = 'main2'
                        raise delivery.ApiError(422, 'not a fast-forward')
                    self.updates.append(data)
                    return {}
                raise AssertionError(path)
        api = API()
        def git(*args):
            if args[0] == 'show':
                return 'spec:\n  targetRevision: 0.1.0-ci.9.1\n  custom: '+args[1].split(':')[0]
            raise AssertionError(args)
        def process(args, **kwargs):
            if args[1] == 'show':
                return subprocess.CompletedProcess(args, 0, '{"run_number":22,"run_attempt":1}', '') if stale else subprocess.CompletedProcess(args, 128, '', '')
            return subprocess.CompletedProcess(args, 0, '', '')
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                Path('scripts').mkdir()
                Path('scripts/staging-config.json').write_text('{"project":"app","components":["db","api","web"],"publish_jobs":["Build api","Build web","Publish CloudNativePG database chart"]}')
                with patch.object(delivery, 'git', side_effect=git), patch.object(delivery, 'branch_changes', return_value=''), patch.object(delivery.subprocess, 'run', side_effect=process), patch.object(delivery.time, 'sleep'):
                    if partial:
                        with self.assertRaises(SystemExit): delivery.promote(api, 'owner/repo', 42)
                    elif reject_check:
                        with self.assertRaises(delivery.ApiError): delivery.promote(api, 'owner/repo', 42)
                    else:
                        delivery.promote(api, 'owner/repo', 42)
            finally:
                os.chdir(previous)
        return api

    def test_atomic_promotion_changes_only_deploy_state(self):
        api = self.exercise()
        self.assertEqual(len(api.updates), 1)
        self.assertFalse(api.updates[0]['force'])
        self.assertEqual({x['path'] for x in api.trees[0]['tree']}, {'gitops/staging/db.yaml','gitops/staging/api.yaml','gitops/staging/web.yaml','gitops/staging/.release.json'})
        self.assertEqual(api.checks[0]['name'], delivery.GUARD)

    def test_concurrent_main_change_is_retried_and_preserved(self):
        api = self.exercise(race=True)
        self.assertEqual(len(api.trees), 2)
        self.assertIn('custom: main2', api.trees[-1]['tree'][0]['content'])
        self.assertEqual(api.updates, [{'sha':'commit2','force':False}])

    def test_older_or_already_promoted_build_cannot_overwrite_newer_release(self):
        self.assertFalse(self.exercise(stale=True).trees)

    def test_superseded_feature_commit_cannot_promote(self):
        self.assertFalse(self.exercise(superseded=True).trees)

    def test_mixed_attempts_cannot_promote_incomplete_chart_set(self):
        self.assertFalse(self.exercise(partial=True).trees)

    def test_failed_required_check_does_not_update_main(self):
        self.assertFalse(self.exercise(reject_check=True).updates)


if __name__ == "__main__":
    unittest.main()

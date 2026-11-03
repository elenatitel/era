# Shared staging delivery policy

Argo CD always watches `main:gitops/staging`. Application code on main can differ
from staging: the exact deployed feature commit is recorded with the chart versions.

## Normal development

1. Branch from an up-to-date main, for example `feature/booking`, `fix/login` or
   another development branch. Existing branches must first merge/rebase main to
   receive the workflow definitions. `main` and the reserved `gitops/*` branches
   do not publish application builds.
2. Push application, chart, dependency or delivery-script changes. CI tests and
   builds the application, then publishes AMD64/ARM64 images tagged
   `ci-RUN_NUMBER.RUN_ATTEMPT`, `sha-SOURCE_SHA` and a unique build ID. OCI Helm
   chart versions are `0.1.0-ci.RUN_NUMBER.RUN_ATTEMPT`; each application chart
   locks the image index digest. PR builds validate without publishing.
3. After the complete build succeeds, a separate `workflow_run` workflow executes
   trusted code from main. It checks the run identity, repository, source branch
   head, successful publishing jobs and a complete chart set from the same attempt.
4. The bot makes one atomic commit on main, changing only the three Application
   chart versions and `gitops/staging/.release.json` provenance. It preserves all
   current application code and Helm configuration on main. Argo CD ignores the
   provenance JSON and automatically syncs the YAML Applications.
5. Later, open a normal feature-to-main PR to merge code. An unchanged tracked
   GitOps directory does not revert bot updates made on main since branching.
   Do not add it to `.gitignore` or remove it from Git tracking.

Every feature shares one staging environment. The newest successfully promoted
build wins across branches. Promotions are serialized, compare numeric run/attempt
numbers, reject superseded source commits and retry concurrent main changes with
fast-forward-only updates. An old build finishing late cannot roll staging back.

Main pushes never build images. Bot pushes use GITHUB_TOKEN and do not recursively
trigger Actions; Argo CD detects the Git commit normally. No personal token or
cluster kubeconfig is stored in Actions. Harbor credentials remain the existing
`HARBOR_USERNAME` and `HARBOR_PASSWORD` secrets.

## PR protection

The `Protect staging manifests` check runs trusted main code via
`pull_request_target`; it never checks out or executes PR code. It inspects all
changed paths, including deletions and renames, and rejects feature PRs that alter
`gitops/staging` (including release provenance).

A deliberately named `gitops/*` PR may change only files under `gitops/`, for an
intentional configuration change or rollback. Keep application changes separate.
Make `Protect staging manifests` a required main-branch status check, with the
GitHub Actions app as its expected source. Promotion commits receive the same
successful check from trusted logic after their allowed changes are constructed;
no general branch-protection bypass is needed.

If a feature accidentally changed staging, restore those paths to the feature's
merge-base with main before submitting the PR. Copying the latest deployment state
into the feature is unnecessary and can itself introduce unwanted changes.

## Operations

Inspect `gitops/staging/.release.json` for the source branch, SHA, build URL and
version. Argo CD child Applications show the deployed chart versions.

To retry promotion of a completed build, dispatch
`Promote staging from successful feature build` on main with its **build run ID**.
The same eligibility and ordering checks still apply. If publishing was partially
re-run, use **Re-run all jobs** in the original image workflow, so every chart has
the same new attempt number. An older run cannot be forced over a newer release.

For a deliberate rollback, open a `gitops/*` configuration PR selecting an older
compatible chart version (the local `scripts/promote-staging.py VERSION` helper
preserves all other configuration). Database migrations remain forward-only;
verify schema compatibility. Normal automatic delivery resumes with the next
newer feature build.

Repository administrators can install the required-check policy with:

```sh
gh api --method PUT repos/OWNER/REPOSITORY/branches/main/protection \
  --input .github/main-protection.json
```

This requires repository administrator access, not just collaborator write access.
It leaves GitOps-only bot commits possible without an approval/bypass token.

# Images, charts and staging delivery

Staging: https://era-staging.cloud.retreat480.com.

Argo CD watches **main**, directory `gitops/staging`. Pushes to development
branches run tests and publish images/charts; successful complete builds are
automatically promoted to main using GitHub Actions' built-in token. Images use
`ci-RUN_NUMBER.RUN_ATTEMPT` tags, while Helm chart versions are
`0.1.0-ci.RUN_NUMBER.RUN_ATTEMPT` and lock exact image digests.

See [the shared delivery policy](staging-delivery.md) for feature/PR behavior,
ordering, branch protection, reruns and intentional GitOps changes.

## Registry credentials

Repository Actions secrets are `HARBOR_USERNAME` and `HARBOR_PASSWORD` (not
`HARBOR_USER`/`PWD`). Use the project-scoped `github-actions` robot with push/pull.
Separate pull-only robots are stored in the `harbor-era-oci` Argo CD repository
Secret and the `era-staging/harbor-era-pull` Kubernetes image pull Secret.
The Git repository is public; Argo CD does not need a GitHub token.

## Shared HA PostgreSQL

The database chart runs in namespace `postgres` and creates only these resources
on the existing CloudNativePG cluster `postgres-geo`:

- database `era_staging`, owned by `era_staging_owner`;
- login roles `era_staging_owner` and `era_staging_app`, both without superuser,
  role/database creation or RLS bypass privileges;
- narrowly scoped RBAC letting the cluster read their two password Secrets.

Password Secrets `postgres/era-staging-owner` and `postgres/era-staging-app` use
`kubernetes.io/basic-auth` with `username` and `password`. They are provisioned
outside Git. Database and role reclaim policies retain data when chart resources
are deleted. No standalone PostgreSQL StatefulSet, PVC or local PV is created.
The existing cluster's replication, failover and backup policy apply to ERA too.

API connection strings use `postgres-geo-rw.postgres.svc.cluster.local:5432` and
`era_staging`. The migration init container receives the owner URL, serializes
migrations with a PostgreSQL advisory lock, and grants application privileges.
The running API receives only the restricted app URL; forced RLS remains active.
Keep one API replica while the login rate limiter uses in-memory state.

## Application secrets and first login

`era-staging/era-api-credentials` contains `DATABASE_URL`,
`DATABASE_MIGRATION_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`,
`PLATFORM_ADMIN_PASSWORD` and `DEMO_PASSWORD`. Never commit these values.
Back up `ENCRYPTION_KEY`: losing it makes stored encrypted data unreadable.

The initial administrator is `admin@era-staging.cloud.retreat480.com`; its password
is in the Kubernetes Secret. Enable 2FA at first login. Demo hotel accounts are
seeded idempotently, including `owner@demo.test`, using `DEMO_PASSWORD`.
Passwords are not printed by the production seed job.

The public app relies on its own authentication; there is no HTTP basic-auth wall
blocking booking pages, guest links or Stripe webhooks. Mailpit captures staging
mail internally and has no public HTTPRoute. Access it when needed with:

```sh
kubectl -n era-staging port-forward svc/era-api-mailpit 8025:8025
```

## Cluster bootstrap and routing

Create namespace/application/database/registry Secrets before applying
`kubectl apply -f gitops/bootstrap.yaml`. The Argo CD project allows application
resources only in `era-staging` and database/RBAC resources in `postgres`; no
cluster-scoped volume permissions are needed. The existing wildcard DNS and TLS,
HAProxy Kubernetes routing and Traefik Gateway serve the staging hostname.

Monitor Argo CD's `era-staging-root`, `era-db`, `era-api`, and `era-web`
Applications, the migration init container and seed Job. Health endpoint:
`https://era-staging.cloud.retreat480.com/api/health`.

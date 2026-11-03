# ERA Helm charts

Three independent charts are published to `oci://harbor.cloud.retreat480.com/era`:

- `era-db`: database and restricted owner/runtime roles on the existing
  CloudNativePG `postgres-geo` cluster. Deploy in namespace `postgres`; password
  Secrets are `era-staging-owner` and `era-staging-app`. No database server or
  volume is installed.
- `era-api`: API, serialized migration init container, idempotent seed Job and
  internal Mailpit. Requires `era-api-credentials` and `harbor-era-pull`.
- `era-web`: Next.js application and Gateway HTTPRoute for the website and API.
  Booking pages and webhooks have no HTTP basic-auth barrier. Mailpit's public
  route is disabled by default.

API/web charts require image index SHA-256 digests, with no tag fallback. CI
packages copies with the exact build digest; zero source digests are lint-only
placeholders. Containers run without root/capabilities; API/web use read-only
root filesystems. Run `helm lint charts/era-db charts/era-api charts/era-web`.

See [deployment instructions](../docs/ci.md) for credentials, promotion and rollback.

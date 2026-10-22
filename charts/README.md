# era. charts

Three independent Helm charts, published as OCI charts to `oci://harbor.cloud.retreat480.com/era` and deployed
by Argo CD (see [docs/ci.md](../docs/ci.md)).

| Chart | Contents | Needs |
| --- | --- | --- |
| `era-db` | PostgreSQL 17 (pinned digest) on a retained local volume; creates the least-privileged `pms_app` role on first start | Secret `era-db-credentials`, folder on the node |
| `era-api` | NestJS API; `migrate` init container (owner role) before start; PostSync seed job; Mailpit test inbox | Secret `era-api-credentials`, pull secret `harbor-era-pull` |
| `era-web` | Next.js web app; HTTPRoutes on `traefik-gateway` (`/api` → era-api, `/` → era-web, Mailpit host); Traefik basic-auth Middleware | Secret `era-staging-basic-auth`, pull secret |

Every application chart requires `image.repository` and an `image.digest` (`sha256:…`); there is no tag fallback.
The zero digests in the source charts are placeholders: CI publishes copies with each build's real digest
(`scripts/package-chart.py`). Schemas reject a missing or malformed digest.

All containers run as non-root with dropped capabilities; the API and web app have read-only root filesystems.
Check locally with `helm lint charts/era-db charts/era-api charts/era-web`.

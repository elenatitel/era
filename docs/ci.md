# Images, charts and staging delivery

```
push to main ──► GitHub Actions (images.yml)
                  ├─ build api + web images (amd64, arm64) ──► Harbor: era/api, era/web
                  └─ package era-db, era-api, era-web charts with the image digests ──► Harbor: oci://…/era
promote-staging.py <version> ──► commit gitops/staging ──► Argo CD syncs era-staging:
                  era-db (wave 0) ──► era-api (wave 10: migrations, then seed) ──► era-web (wave 20: app + routes)
```

Same model as UNVRS: images and charts live in the private Harbor project `era`, every chart is locked to the
exact image digest of its build, and staging only changes through an explicit Git commit in `gitops/staging`.

## Every release

1. Merge to `main`. The **Build and publish** workflow pushes the images and three charts. Its run summary shows
   the chart version, `0.1.0-ci.<run>.<attempt>`.
2. Promote that version (all three charts come from the same run):

   ```sh
   python3 scripts/promote-staging.py 0.1.0-ci.<run>.<attempt>
   git diff -- gitops/staging
   git commit -am "Promote staging to 0.1.0-ci.<run>.<attempt>" && git push
   ```

3. Argo CD deploys it. Watch `era-api`: its `migrate` init container applies database migrations before the API
   starts, and the `era-api-seed` job (PostSync) ensures the platform admin and the demo hotel.

**Rollback:** revert the promotion commit. Migrations only move forward, so check that the older API works with
the newer schema before rolling back across a migration.

Pull requests build and lint everything but publish nothing and never receive registry credentials.
Re-run all jobs (not only failed ones) so the three charts share one version.

## One-time setup

Nothing below is committed to Git. Run it as the Harbor, cluster and Argo CD administrator.

### 1. Harbor

- Create the private project **`era`**. Like UNVRS, make chart repositories `era-*` immutable.
- Create three robot accounts in the project:
  - `github-actions` — pull + push. Store it in GitHub → repository **Settings → Secrets and variables → Actions**
    as `HARBOR_USERNAME` (the full robot name, e.g. `robot$era+github-actions`) and `HARBOR_PASSWORD`.
  - `argocd` — pull only, for Argo CD (step 4).
  - `k8s` — pull only, for the nodes (step 2).

### 2. Namespace and secrets

```sh
kubectl create namespace era-staging

# Image pulls (robot k8s)
kubectl -n era-staging create secret docker-registry harbor-era-pull \
  --docker-server=harbor.cloud.retreat480.com --docker-username='robot$era+k8s' --docker-password='<robot secret>'

# Database and API credentials — generated here, never printed, never committed
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
kubectl -n era-staging create secret generic era-db-credentials \
  --from-literal=POSTGRES_DB=pms --from-literal=POSTGRES_USER=pms_owner \
  --from-literal=POSTGRES_PASSWORD="$OWNER_PW" --from-literal=APP_DB_PASSWORD="$APP_PW"
kubectl -n era-staging create secret generic era-api-credentials \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=DATABASE_URL="postgres://pms_app:$APP_PW@era-db:5432/pms" \
  --from-literal=DATABASE_MIGRATION_URL="postgres://pms_owner:$OWNER_PW@era-db:5432/pms" \
  --from-literal=PLATFORM_ADMIN_PASSWORD='<at least 12 characters>' \
  --from-literal=DEMO_PASSWORD='<password for the demo users>'
unset OWNER_PW APP_PW

# Back up ENCRYPTION_KEY somewhere safe: without it, encrypted ID numbers and 2FA secrets are unreadable.
kubectl -n era-staging get secret era-api-credentials -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d

# Staging password for the site and the Mailpit inbox (Traefik basic auth, key "users")
htpasswd -nb tester '<a long password>' > users
kubectl -n era-staging create secret generic era-staging-basic-auth --from-file=users && rm users
```

Set `app.platformAdminEmail` in `charts/era-api/values.yaml` (or leave it empty and create the admin later).

### 3. Database folder

On **k8s-cs-worker02** (or the node set in `charts/era-db/values.yaml`):

```sh
sudo mkdir -p /var/lib/era-staging/postgres
sudo chown 70:70 /var/lib/era-staging/postgres && sudo chmod 700 /var/lib/era-staging/postgres
```

The PersistentVolume and its claim are never pruned or deleted by Argo CD. There are no backups or replicas:
add a scheduled `pg_dump` before anything important lives there.

### 4. Argo CD

- **Harbor charts:** add a Helm repository `harbor.cloud.retreat480.com/era` with **OCI enabled** and the `argocd` robot.
- **GitHub:** this repository is private. Add `https://github.com/elenatitel/era.git` with read-only access
  (a deploy key, or a fine-grained token with *Contents: read*).
- Then: `kubectl apply -f gitops/bootstrap.yaml`. It creates the restricted `era-staging` project and the
  `era-staging-root` app, which watches `gitops/staging` on `main`.

### 5. Routing

- DNS: `era-staging.cloud.retreat480.com` and `era-staging-mail.cloud.retreat480.com` point where
  `unvrs-staging.cloud.retreat480.com` does.
- The `web` listener of `traefik-gateway` (namespace `traefik`) must accept routes from the `era-staging`
  namespace (`allowedRoutes`), and Traefik's Gateway provider must allow `ExtensionRef` filters to Traefik
  Middleware (Traefik v3), which carries the basic auth.

## Notes

- `gitops/staging` starts at `0.1.0-ci.1.1`, the version of the first publishing run. If another run publishes
  first, promote the real version; until then Argo CD reports the chart as missing.
- Staging sits behind basic auth, so Stripe webhooks cannot reach it. Card payments are still confirmed when the
  guest returns from Stripe.
- `app.trustProxy: 1` assumes Traefik is the only proxy adding `X-Forwarded-For`. Raise it if another one sits in front.
- Multi-architecture builds run arm64 under emulation and take longer; drop `linux/arm64` if no node needs it.
- Actions are pinned to commit hashes, and checkout does not keep GitHub credentials.

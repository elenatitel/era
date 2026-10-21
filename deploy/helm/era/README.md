# era. Helm chart

Deploys era. to Kubernetes: the **api** (NestJS) and **web** (Next.js) images built from the root
`Dockerfile`, an Ingress that sends `/api` to the API and everything else to the web app, and database
migrations that run before the API starts. For staging it can also run **PostgreSQL**, **Mailpit**
(a web inbox that catches every e-mail) and a **demo hotel**, all behind a password.

## Requirements

- Kubernetes 1.27+, an ingress controller (the defaults assume ingress-nginx) and, for HTTPS,
  cert-manager with a ClusterIssuer.
- The images in a registry the cluster can pull from (CI publishes them to GitHub Container Registry).

## Install staging

```bash
# 1. Password for the whole site (testers sign in with it in the browser)
htpasswd -c auth tester
kubectl create namespace era-staging
kubectl -n era-staging create secret generic era-staging-auth --from-file=auth

# 2. Install with fresh secrets (keep a copy of ENCRYPTION_KEY: it cannot be recovered)
helm upgrade --install era deploy/helm/era -n era-staging \
  -f deploy/helm/era/values-staging.yaml \
  --set secrets.jwtSecret=$(openssl rand -hex 32) \
  --set secrets.encryptionKey=$(openssl rand -base64 32) \
  --set database.ownerPassword=$(openssl rand -hex 16) \
  --set database.appPassword=$(openssl rand -hex 16) \
  --set secrets.platformAdminPassword='choose-a-long-one' \
  --set secrets.demoPassword='Demo-staging-123'
```

The chart keeps its Secret on uninstall (`helm.sh/resource-policy: keep`). On later upgrades either pass
the same values again or, better, create the Secret yourself and set `secrets.existingSecret`.

## Production

Use a managed PostgreSQL (`postgres.enabled: false`, `database.host`, `database.ssl: true`) and create the
application role once, as described in `values.yaml`. Keep `api.replicas: 1` until the login rate limiter
uses a shared store. Manage secrets with an existing Secret (sealed-secrets, External Secrets or SOPS).

## Values

See [values.yaml](values.yaml): every setting is commented.

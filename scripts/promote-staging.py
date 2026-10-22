#!/usr/bin/env python3
"""Record one published chart version for all era. staging applications (db, api, web).

Commit and push the changed gitops/staging files: Argo CD deploys that commit.
Reverting the commit rolls staging back to the previous charts and their pinned images.
"""
import argparse
from pathlib import Path
import re

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('version', help='Published chart version, e.g. 0.1.0-ci.3.1')
a = p.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', a.version):
    p.error('An explicit SemVer chart version is required')
root = Path(__file__).resolve().parents[1] / 'gitops/staging'
root.mkdir(parents=True, exist_ok=True)
# Sync waves: the database first, then the API (runs migrations), then the web app and routes.
for component, wave in [('db', 0), ('api', 10), ('web', 20)]:
    text = f'''apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: era-{component}
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "{wave}"
spec:
  project: era-staging
  source:
    repoURL: harbor.cloud.retreat480.com/era
    chart: era-{component}
    targetRevision: {a.version}
    helm:
      releaseName: era-{component}
  destination:
    server: https://kubernetes.default.svc
    namespace: era-staging
  syncPolicy:
    automated:
      prune: false
      selfHeal: true
'''
    (root / f'{component}.yaml').write_text(text)
print('Staging chart versions set to', a.version)
print('Commit and push gitops/staging to promote; reverting that commit rolls back.')

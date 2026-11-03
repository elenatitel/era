#!/usr/bin/env python3
"""Prepare an intentional GitOps-only version change; routine delivery is automatic."""
import argparse
import json
from pathlib import Path
import re
from staging_delivery import replace_revision

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('version')
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', args.version):
    parser.error('An explicit chart SemVer is required')
root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'scripts/staging-config.json').read_text())
for component in config['components']:
    path = root / 'gitops/staging' / (component + '.yaml')
    path.write_text(replace_revision(path.read_text(), args.version))
print('Prepared version change. Use a separate gitops/* PR for intentional configuration/rollback changes.')

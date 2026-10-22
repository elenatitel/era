#!/usr/bin/env python3
"""Package a chart with a build's exact image-index digest baked into its defaults.

The source chart is copied to a temporary folder first; the files in Git are never changed.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('chart', type=Path)
parser.add_argument('--version', required=True)
parser.add_argument('--app-version', required=True)
parser.add_argument('--repository')
parser.add_argument('--digest')
parser.add_argument('--destination', type=Path, default=Path('dist/charts'))
args = parser.parse_args()
if bool(args.repository) != bool(args.digest):
    parser.error('--repository and --digest must be provided together')
if args.digest and not re.fullmatch(r'sha256:[a-f0-9]{64}', args.digest):
    parser.error('digest must be a SHA-256 image-index digest')
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', args.version):
    parser.error('version must be an explicit SemVer release')
args.destination.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='era-chart-') as temp:
    chart = Path(temp) / args.chart.name
    shutil.copytree(args.chart, chart)
    if args.digest:
        values = chart / 'values.yaml'
        image = 'image:\n' + ''.join(
            f'  {key}: {json.dumps(value)}\n'
            for key, value in {'repository': args.repository, 'digest': args.digest,
                               'pullPolicy': 'IfNotPresent'}.items()
        )
        # Only the top-level image block (column 0); nested blocks such as mailpit.image are untouched.
        text, count = re.subn(r'^image:\n(?:[ \t]+[^\n]*\n)*', lambda _: image,
                              values.read_text(), count=1, flags=re.MULTILINE)
        if count != 1:
            raise SystemExit('Expected one top-level image block in chart values')
        values.write_text(text)
    subprocess.run(['helm', 'lint', str(chart)], check=True)
    subprocess.run(['helm', 'package', str(chart), '--version', args.version,
                    '--app-version', args.app_version, '--destination',
                    str(args.destination)], check=True)

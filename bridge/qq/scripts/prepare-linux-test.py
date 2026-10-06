#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Assemble a fresh isolated QQ/NapCat test installation; never start either."""
import argparse
import json
from pathlib import Path
import shutil
import re
import hashlib
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--qq-source', required=True, help='Unpacked official complete Linux QQ directory')
parser.add_argument('--napcat-source', required=True, help='Existing distribution files, never account config')
parser.add_argument('--target', required=True, help='New empty directory for the independent test instance')
parser.add_argument('--port', type=int, default=6120)
parser.add_argument('--av-port', type=int, default=6121)
args = parser.parse_args()
qq_source = Path(args.qq_source).resolve()
napcat_source = Path(args.napcat_source).resolve()
target = Path(args.target).resolve()
if target.exists():
    parser.error('Target already exists; refusing to overwrite an experiment or account state')
if not (qq_source / 'resources/app/avsdk/libAVSDKPlugin.so').is_file():
    parser.error('A complete official QQ with AVSDK is required')
if not (napcat_source / 'napcat.mjs').is_file():
    parser.error('NapCat distribution is missing napcat.mjs')
if not 1 <= args.port <= 65535 or not 1 <= args.av_port <= 65535:
    parser.error('Ports must be in 1..65535')
target.mkdir(parents=True, mode=0o700)
qq = target / 'QQ'
napcat = target / 'napcat'
bridge = target / 'bridge'
shutil.copytree(qq_source, qq, symlinks=True)
napcat.mkdir(mode=0o700)
# Explicit distribution allowlist. No live config, credentials, account data,
# plugin settings, databases, logs or QQ login state are copied.
distribution_names = {'napcat.mjs', 'native', 'node_modules', 'worker', 'static', 'package.json'}
# Rollup emits runtime-imported hashed chunks beside napcat.mjs. Include only
# top-level executable modules/native binaries, never arbitrary JSON account data.
distribution_names.update(item.name for item in napcat_source.iterdir()
                          if item.is_file() and item.suffix in {'.js', '.cjs', '.mjs', '.node'}
                          and not item.name.endswith('.original.mjs'))
for name in sorted(distribution_names):
    source = napcat_source / name
    if source.is_dir():
        shutil.copytree(source, napcat / name, symlinks=True)
    elif source.is_file():
        shutil.copy2(source, napcat / name)
(napcat / 'config').mkdir(mode=0o700)
(napcat / 'plugins').mkdir(mode=0o700)
# NapCat's own native data path fallback bypasses Electron --user-data-dir.
# Patch only this new distribution copy to honor the dedicated test path, and
# retain the original file/hash. Never patch an existing installed distribution.
bundle = napcat / 'napcat.mjs'
original_bundle = bundle.read_text()
pattern = r'([A-Za-z_$][A-Za-z0-9_$.]*\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\))'
matches = list(re.finditer(pattern, original_bundle))
if len(matches) != 2:
    raise RuntimeError('Unrecognized NapCat data-path implementation; refusing to prepare a non-isolated test')
data_dir = bridge / 'runtime/qq-data'
data_dir.mkdir(parents=True, mode=0o700)
bundle.with_name('napcat.original.mjs').write_text(original_bundle)
patched_bundle = re.sub(pattern, lambda match: '(' + json.dumps(str(data_dir)) + ')', original_bundle)
bundle.write_text(patched_bundle)
package_file = qq / 'resources/app/package.json'
package = json.loads(package_file.read_text())
(package_file.parent / 'package.original.json').write_bytes(package_file.read_bytes())
package['main'] = './loadNapCat.js'
package_file.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
loader = ('"use strict";\n'
          'const { pathToFileURL } = require("node:url");\n'
          'process.env.NAPCAT_WORKDIR = ' + json.dumps(str(napcat)) + ';\n'
          'import(pathToFileURL(' + json.dumps(str(napcat / 'napcat.mjs')) + ').href)'
          '.catch(error => { console.error("NapCat test startup failed", error.message); process.exitCode = 1; });\n')
(package_file.parent / 'loadNapCat.js').write_text(loader)
subprocess.run([sys.executable, str(Path(__file__).with_name('install.py')), 'install',
                '--qq-dir', str(qq), '--napcat-dir', str(napcat), '--install-dir', str(bridge),
                '--port', str(args.port), '--av-port', str(args.av_port)], check=True)
local_bootstrap = 'not in official plugin whitelist' in patched_bundle
if local_bootstrap:
    subprocess.run([sys.executable, str(Path(__file__).with_name('enable-local-plugin.py')),
                    '--napcat-dir', str(napcat),
                    '--loader', str(qq / 'resources/app/loadNapCat.koishi-rtc-qq.backup.cjs')], check=True)
manifest = {'preparedOnly': True, 'processesStarted': False, 'accountsCopied': False,
            'qqSource': str(qq_source), 'napcatDistributionSource': str(napcat_source),
            'qqDir': str(qq), 'napcatDir': str(napcat), 'bridgeDir': str(bridge),
            'controlPort': args.port, 'avHostPort': args.av_port,
            'isolatedQQDataPath': str(data_dir), 'napcatDataPathPatchCount': len(matches),
            'originalNapCatSHA256': hashlib.sha256(original_bundle.encode()).hexdigest(),
            'patchedNapCatSHA256': hashlib.sha256(bundle.read_bytes()).hexdigest(),
            'explicitLocalPluginBootstrap': local_bootstrap,
            'qqVersion': package.get('version'),
            'compatibility': 'New QQ with this NapCat distribution requires runtime validation before calls.'}
(target / 'experiment.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))

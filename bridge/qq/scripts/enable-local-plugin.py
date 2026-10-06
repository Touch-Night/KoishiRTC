#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Enable one explicit local bootstrap in an independent NapCat copy. Never starts QQ."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--napcat-dir', required=True)
parser.add_argument('--loader', required=True, help='The independent CommonJS loader that imports NapCat')
parser.add_argument('--restore', action='store_true')
args = parser.parse_args()
napcat = Path(args.napcat_dir).resolve()
loader = Path(args.loader).resolve()
bundle = napcat / 'napcat.mjs'
plugin = napcat / 'plugins/napcat-plugin-koishi-rtc-qq'
manifest = napcat / 'koishi-rtc-local-bootstrap.json'
digest = lambda data: hashlib.sha256(data).hexdigest()
if args.restore:
    record = json.loads(manifest.read_text())
    for item in record['files']:
        target = Path(item['path'])
        if digest(target.read_bytes()) != item['patchedSHA256']:
            parser.error('A managed file changed; refusing to overwrite it: ' + str(target))
    for item in record['files']:
        Path(item['path']).write_bytes(Path(item['backup']).read_bytes())
    manifest.rename(manifest.with_suffix('.restored.json'))
    print(json.dumps({'restored': True, 'processesStarted': False}))
    sys.exit(0)
if manifest.exists():
    record = json.loads(manifest.read_text())
    if all(digest(Path(item['path']).read_bytes()) == item['patchedSHA256'] for item in record['files']):
        print(json.dumps({'installed': True, 'unchanged': True, 'processesStarted': False})); sys.exit(0)
    parser.error('Managed local bootstrap files changed; review before replacing')
if not (plugin / 'index.mjs').is_file():
    parser.error('Install the local bridge plugin before adding its explicit bootstrap')
original = bundle.read_text()
# Apply to the distribution variant with the verified PluginManager shape only.
anchor = '    const n = this.getLoadedPlugins().length;'
if original.count(anchor) != 1 or 'not in official plugin whitelist' not in original:
    parser.error('Unrecognized NapCat plugin scan; no broad whitelist bypass will be installed')
hook = ('    // KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1\n'
        '    {\n'
        '      const rtcLocalKey = Symbol.for("koishi-rtc.qq.local-plugin-bootstrap.v1");\n'
        '      if (!globalThis[rtcLocalKey]) {\n'
        '        const { default: registerLocalRTC } = await import(new URL("./koishi-rtc-bootstrap.cjs", import.meta.url));\n'
        '        registerLocalRTC(' + json.dumps(str(plugin)) + ');\n'
        '      }\n'
        '      await globalThis[rtcLocalKey](this);\n'
        '    }\n')
patched_bundle = original.replace(anchor, hook + anchor)
bootstrap = napcat / 'koishi-rtc-bootstrap.cjs'
bootstrap_source = Path(__file__).with_name('local-plugin-bootstrap.cjs').read_bytes()
original_loader = loader.read_bytes()
if b'KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1' in original_loader:
    parser.error('Loader already contains an untracked local bootstrap')
patched_loader = ('"use strict";\n// KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1\nrequire(' + json.dumps(str(bootstrap)) + ')(' + json.dumps(str(plugin)) + ');\n').encode() + original_loader
files = []
for target, before, after in [(bundle, original.encode(), patched_bundle.encode()), (loader, original_loader, patched_loader)]:
    backup = target.with_name(target.name + '.before-koishi-rtc-local-plugin')
    if backup.exists(): parser.error('Backup already exists; refusing to replace ' + str(backup))
    files.append({'path': str(target), 'backup': str(backup), 'originalSHA256': digest(before), 'patchedSHA256': digest(after)})
# All checks precede writes. Backups retain exact bytes for guarded restoration.
bootstrap.write_bytes(bootstrap_source)
for item, after in zip(files, [patched_bundle.encode(), patched_loader]):
    target = Path(item['path']); Path(item['backup']).write_bytes(target.read_bytes()); target.write_bytes(after)
record = {'schemaVersion': 1, 'explicitLocalPlugin': 'napcat-plugin-koishi-rtc-qq',
          'officialWhitelistChanged': False, 'processesStarted': False, 'files': files,
          'bootstrap': str(bootstrap), 'bootstrapSHA256': digest(bootstrap_source)}
manifest.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'installed': True, 'processesStarted': False, 'restartRequired': True, 'manifest': str(manifest)}, indent=2))

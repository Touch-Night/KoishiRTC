#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Install an owned QQ.app/NapCat copy. Never changes the original app or starts QQ."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import secrets
import shutil
import subprocess
import sys
from probe import inspect

FORMAT = 'koishi-rtc-macos-v1'
HERE = Path(__file__).resolve().parent
PLUGIN_ID = 'napcat-plugin-koishi-rtc-qq'
SCAN_ANCHOR = '    const n = this.getLoadedPlugins().length;'
BOOTSTRAP_MARKER = 'KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1'
MEDIA_RUNTIME_FILES = ('audio/common.mjs', 'video/index.mjs', 'video/source.mjs',
                       'video/protocol.mjs', 'video/queue.mjs', 'video/virtual-camera.mjs',
                       'video/demo.mjs', 'video/virtual_camera_worker.py', 'video/requirements.txt')


def media_runtime_files(source=None):
    root = source if source is not None else HERE.parent.parent
    result = [(relative, root / relative) for relative in MEDIA_RUNTIME_FILES]
    for _, path in result:
        if not path.is_file() or path.is_symlink() or path.resolve() != path:
            raise ValueError(f'Media runtime source missing or symbolic: {path}')
    return result


def copy_bridge_sources(source, target):
    """Copy this project's scripts, excluding local runtime state and binaries."""
    for path in source.iterdir():
        if path.name.lower() in ('runtime', '__pycache__', 'log', 'logs', 'cache', 'node_modules', 'qq'):
            continue
        if path.is_symlink():
            raise ValueError(f'Bridge source must not use symbolic links: {path}')
        if path.is_dir():
            copy_bridge_sources(path, target / path.name)
        elif path.is_file() and path.suffix.lower() in ('.mjs', '.cjs', '.json', '.py', '.sh', '.ps1', '.html', '.md'):
            target.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target / path.name)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def canonical(value):
    return Path(value).expanduser().resolve()


def inspect_napcat(napcat):
    """Recognize the exact worker hook shape without importing NapCat code."""
    bundle = napcat / 'napcat.mjs'
    if not bundle.is_file():
        raise ValueError('NapCat directory must contain a complete unpacked NapCat.Shell release including napcat.mjs.')
    if any(path.is_symlink() for path in napcat.rglob('*')):
        raise ValueError('Use a fresh unpacked NapCat release without symbolic links; hooks must never write through to source files.')
    text = bundle.read_text()
    if text.count(SCAN_ANCHOR) != 1 or 'not in official plugin whitelist' not in text or BOOTSTRAP_MARKER in text:
        raise ValueError('Unrecognized or already modified NapCat worker scan; no local bootstrap will be installed.')
    return {'workerSelfRegisters': True, 'officialWhitelistChanged': False,
            'explicitLocalPlugin': PLUGIN_ID, 'sourceBundleSHA256': hashlib.sha256(bundle.read_bytes()).hexdigest()}


def owned_directory(value):
    dest = canonical(value)
    marker = json.loads((dest / '.koishi-rtc-owned.json').read_text())
    if marker.get('format') != FORMAT or marker.get('directory') != str(dest) or dest in (Path('/'), Path.home()):
        raise ValueError('Refusing to change a directory without a matching ownership marker.')
    return dest


def require_closed(dest):
    # Never terminates any process. The Electron utility worker may expose only
    # its NapCat path, so check both our copied app and the copied worker directory.
    if platform.system() == 'Darwin':
        output = subprocess.run(['ps', '-axo', 'command='], check=True, text=True, capture_output=True).stdout
        if str(dest / 'QQ-RTC.app/Contents/') in output or str(dest / 'napcat/') in output:
            raise ValueError('Close this installation\'s QQ/Host/NapCat processes before changing its files.')


def validate_bootstrap(dest):
    """Validate every managed path and backup before allowing restore/launch."""
    napcat = dest / 'napcat'
    manifest = napcat / 'koishi-rtc-local-bootstrap.json'
    if not manifest.is_file():
        raise ValueError('NapCat local worker bootstrap is missing or restored; reinstall into a fresh owned copy.')
    record = json.loads(manifest.read_text())
    expected = {napcat / 'napcat.mjs', napcat / 'koishi-rtc-loader.cjs'}
    files = record.get('files', [])
    if record.get('schemaVersion') != 1 or record.get('explicitLocalPlugin') != PLUGIN_ID or record.get('officialWhitelistChanged') is not False or len(files) != 2 or {Path(item['path']) for item in files} != expected:
        raise ValueError('Unexpected local bootstrap restoration manifest.')
    for item in files:
        target, backup = Path(item['path']), Path(item['backup'])
        if target.resolve() != target or backup != target.with_name(target.name + '.before-koishi-rtc-local-plugin') or backup.resolve() != backup:
            raise ValueError('Local bootstrap paths must belong to the owned copy without symbolic links.')
        if hashlib.sha256(target.read_bytes()).hexdigest() != item['patchedSHA256'] or hashlib.sha256(backup.read_bytes()).hexdigest() != item['originalSHA256']:
            raise ValueError('Local bootstrap files or backups changed; refusing to replace or launch them.')
    bootstrap = napcat / 'koishi-rtc-bootstrap.cjs'
    if record.get('bootstrap') != str(bootstrap) or bootstrap.resolve() != bootstrap or hashlib.sha256(bootstrap.read_bytes()).hexdigest() != record.get('bootstrapSHA256'):
        raise ValueError('Local bootstrap helper changed.')
    worker = (napcat / 'napcat.mjs').read_text()
    if 'await import(new URL("./koishi-rtc-bootstrap.cjs", import.meta.url))' not in worker:
        raise ValueError('NapCat utility worker lacks its own bootstrap import; parent globals are insufficient.')
    return record


def restore_bootstrap(args):
    dest = owned_directory(args.install_dir)
    require_closed(dest)
    record = validate_bootstrap(dest)
    config_file = dest / 'napcat/config/plugins.json'
    if config_file.resolve() != config_file:
        raise ValueError('NapCat plugin configuration must not point outside its owned path.')
    enabled = json.loads(config_file.read_text())
    if not isinstance(enabled, dict):
        raise ValueError('NapCat plugin configuration must be an object.')
    print(json.dumps({'restoresFiles': [item['path'] for item in record['files']],
                      'disablesLocalPlugin': PLUGIN_ID, 'changesOriginalQQ': False,
                      'preservesOwnedCopy': True, 'processesStarted': False}))
    if args.check:
        return
    subprocess.run([sys.executable, str(dest / 'bridge/qq/scripts/enable-local-plugin.py'),
                    '--napcat-dir', str(dest / 'napcat'), '--loader', str(dest / 'napcat/koishi-rtc-loader.cjs'), '--restore'], check=True)
    enabled[PLUGIN_ID] = False
    write_json(config_file, enabled)


def install(args):
    source, napcat, dest = canonical(args.qq_app), canonical(args.napcat_dir), canonical(args.install_dir)
    media_runtime = media_runtime_files()
    report = inspect(source)
    if source in dest.parents or dest == source or dest in source.parents or napcat == dest or dest in napcat.parents or napcat in dest.parents:
        raise ValueError('Source app, NapCat, and installation directories must not overlap.')
    if dest.exists():
        raise ValueError('Installation directory already exists; choose a new path or uninstall the owned copy first.')
    if report.get('entry') not in ('./application.asar/app_launcher/index.js', './application/app_launcher/index.js', './app_launcher/index.js'):
        report['blockers'].append('Source QQ must have an unmodified official entry point.')
    try:
        report['localBootstrap'] = inspect_napcat(napcat)
    except (OSError, ValueError) as error:
        report['blockers'].append(str(error))
    package_source = source / 'Contents/Resources/app/package.json'
    if package_source.resolve() != package_source:
        report['blockers'].append('QQ package entry must not use symbolic links; copied hooks must not write through to the source.')
    if any(path.is_symlink() and (Path(os.readlink(path)).is_absolute() or not path.resolve().is_relative_to(source)) for path in source.rglob('*')):
        report['blockers'].append('QQ bundle has absolute or external symbolic links; use an unmodified official application.')
    if any((napcat / name).exists() for name in ['config', 'logs']):
        report['blockers'].append('Use a fresh unpacked NapCat release: copying an existing config/log directory could copy account data.')
    if not 1 <= args.port <= 65535 or not 1 <= args.av_port <= 65535 or args.port == args.av_port:
        report['blockers'].append('Bridge and AV ports must be distinct valid TCP ports.')
    report['plan'] = {'copyQQFrom': str(source), 'copyNapCatFrom': str(napcat), 'installDirectory': str(dest),
                      'adHocSignCopy': args.adhoc_sign, 'launchesProcesses': False,
                      'changesOriginalQQ': False, 'mediaEnabledByDefault': False,
                      'accountIsolation': 'Bundle identifier is preserved. Use a dedicated macOS user for an isolated QQ account.'}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report['blockers']:
        raise ValueError('Resolve the listed blockers before installing.')
    if args.check:
        return
    if platform.system() != 'Darwin':
        raise ValueError('Installation/signing require macOS; use --check for read-only inspection on other systems.')
    if not shutil.which('ditto') or args.adhoc_sign and not shutil.which('codesign'):
        raise ValueError('macOS ditto/codesign is unavailable.')
    old_umask = os.umask(0o077)
    created = False
    try:
        dest.mkdir(parents=True, exist_ok=False)
        created = True
        write_json(dest / '.koishi-rtc-owned.json', {'format': FORMAT, 'directory': str(dest)})
        app_copy = dest / 'QQ-RTC.app'
        subprocess.run(['ditto', str(source), str(app_copy)], check=True)
        shutil.copytree(napcat, dest / 'napcat', symlinks=True)
        # Install the complete shared implementation, keeping the Mac bootstrap thin.
        copy_bridge_sources(HERE.parent, dest / 'bridge/qq')
        # Never recursively copy audio/video: a development checkout may have
        # local native builds, tokens or Python caches alongside its sources.
        for relative, source_file in media_runtime:
            destination = dest / 'bridge' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_file, destination)
        plugin = dest / 'napcat/plugins' / PLUGIN_ID
        if plugin.exists():
            raise ValueError('Fresh NapCat release unexpectedly contains this plugin already.')
        shutil.copytree(HERE.parent / 'napcat-plugin', plugin)
        (dest / 'napcat/config').mkdir(mode=0o700)
        write_json(dest / 'napcat/config/plugins.json', {PLUGIN_ID: True})
        # Use a separate CommonJS parent loader outside the signed app. The
        # shared patch also imports its helper inside utilityProcess workers.
        loader = dest / 'napcat/koishi-rtc-loader.cjs'
        loader.write_text('"use strict";\nmodule.exports = import("./napcat.mjs");\n')
        subprocess.run([sys.executable, str(dest / 'bridge/qq/scripts/enable-local-plugin.py'),
                        '--napcat-dir', str(dest / 'napcat'), '--loader', str(loader)], check=True)
        local_bootstrap = validate_bootstrap(dest)
        runtime = dest / 'runtime'
        runtime.mkdir(mode=0o700)
        token_file = runtime / 'control.token'
        token_file.write_text(secrets.token_hex(32) + '\n')
        token_file.chmod(0o600)
        write_json(plugin / 'bridge-config.json', {'controlHost': '127.0.0.1', 'controlPort': args.port,
                   'avHost': '127.0.0.1', 'avPort': args.av_port, 'tokenFile': str(token_file), 'mediaEnabled': False})
        app = app_copy / 'Contents/Resources/app'
        package_file = app / 'package.json'
        original = package_file.read_bytes()
        package = json.loads(original)
        if package.get('main') not in ('./application.asar/app_launcher/index.js', './application/app_launcher/index.js', './app_launcher/index.js'):
            raise ValueError('Source QQ must have an unmodified official entry point.')
        (dest / 'package.original.json').write_bytes(original)
        bootstrap = {'originalMain': package['main'], 'hostEntry': str(dest / 'bridge/qq/macos/host.cjs'),
                     'napcatLoader': str(loader)}
        shutil.copy2(HERE / 'entry.cjs', app / 'koishi-rtc-entry.cjs')
        write_json(app / 'koishi-rtc-bootstrap.json', bootstrap)
        package['main'] = './koishi-rtc-entry.cjs'
        write_json(package_file, package)
        info = plistlib.loads((app_copy / 'Contents/Info.plist').read_bytes())
        # The dedicated app copy owns TCC prompts; preserve official wording when present.
        info.setdefault('NSCameraUsageDescription', 'Send the camera you explicitly select in Koishi RTC calls.')
        info.setdefault('NSMicrophoneUsageDescription', 'Use explicitly configured virtual audio devices for Koishi RTC calls.')
        (app_copy / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        sdk_copy = app / 'avsdk/libAVSDKPlugin.dylib'
        sdk_digest = hashlib.sha256(sdk_copy.read_bytes()).hexdigest()
        if args.adhoc_sign:
            # Only the outer bundle's resources changed. Preserve nested native
            # signatures/bytes, including AVSDK's exact audited fingerprint.
            subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none',
                            '--preserve-metadata=entitlements,flags', str(app_copy)], check=True)
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app_copy)], check=True)
        if hashlib.sha256(sdk_copy.read_bytes()).hexdigest() != sdk_digest:
            raise ValueError('Signing changed the AVSDK binary; its exact native profile would no longer match.')
        manifest = {'format': FORMAT, 'directory': str(dest), 'sourceApp': str(source),
                    'qqVersion': package['version'], 'executable': info['CFBundleExecutable'],
                    'bridgePort': args.port, 'avPort': args.av_port, 'adHocSigned': args.adhoc_sign,
                    'originalPackageSHA256': hashlib.sha256(original).hexdigest(),
                    'installedPackageSHA256': hashlib.sha256(package_file.read_bytes()).hexdigest(),
                    'localBootstrap': {'manifest': str(dest / 'napcat/koishi-rtc-local-bootstrap.json'),
                                       'loader': str(loader), 'workerSelfRegisters': True,
                                       'officialWhitelistChanged': local_bootstrap['officialWhitelistChanged']},
                    'runtimeTested': False}
        write_json(dest / 'macos-install.json', manifest)
        print('Installed without starting QQ. Token file: ' + str(token_file))
        if not args.adhoc_sign:
            print('The copied app signature was changed by its entry hook. Sign the copy before expecting macOS to launch it.')
    except Exception:
        # Only remove the directory created by this invocation, never preexisting user data.
        if created and (dest / '.koishi-rtc-owned.json').is_file():
            shutil.rmtree(dest)
        raise
    finally:
        os.umask(old_umask)


def uninstall(args):
    dest = owned_directory(args.install_dir)
    require_closed(dest)
    print(json.dumps({'removesOwnedCopy': str(dest), 'preservesSourceQQ': True,
                      'preservesSystemBlackHole': True, 'preservesQQContainerAccountData': True}))
    if not args.check:
        shutil.rmtree(dest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    add = commands.add_parser('install')
    add.add_argument('--qq-app', required=True)
    add.add_argument('--napcat-dir', required=True)
    add.add_argument('--install-dir', required=True)
    add.add_argument('--port', type=int, default=6110)
    add.add_argument('--av-port', type=int, default=6111)
    add.add_argument('--adhoc-sign', action='store_true', help='Ad-hoc sign the copied application, preserving existing Electron entitlements.')
    add.add_argument('--check', action='store_true')
    remove = commands.add_parser('uninstall')
    remove.add_argument('--install-dir', required=True)
    remove.add_argument('--check', action='store_true')
    restore = commands.add_parser('restore-bootstrap', help='Disable the local extension and restore its guarded worker/loader backups, retaining the installation.')
    restore.add_argument('--install-dir', required=True)
    restore.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        {'install': install, 'uninstall': uninstall, 'restore-bootstrap': restore_bootstrap}[args.command](args)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print('Error: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

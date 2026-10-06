#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Reversible installation design based on ClaudiaGardner/maibot-qq-voice-call.
"""Offline file installer: never starts, stops, logs into, or calls QQ."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import platform
import stat
import sys

PLUGIN = 'napcat-plugin-koishi-rtc-qq'
MARKER = 'KOISHI_RTC_QQ_LOADER_HOOK_V1'
SOURCE = Path(__file__).resolve().parent.parent
MEDIA_RUNTIME_FILES = ('audio/common.mjs', 'video/index.mjs', 'video/source.mjs',
                       'video/protocol.mjs', 'video/queue.mjs', 'video/virtual-camera.mjs',
                       'video/demo.mjs', 'video/virtual_camera_worker.py', 'video/requirements.txt')


def media_runtime_files(source=SOURCE):
    # Source checkout: bridge/{qq,audio,video}. Relocated Linux installation:
    # install/{scripts,av-host,audio,video}. Copy only reviewed source files.
    root = source if (source / 'video/index.mjs').is_file() else source.parent
    result = [(relative, root / relative) for relative in MEDIA_RUNTIME_FILES]
    for _, path in result:
        if not path.is_file() or path.is_symlink() or path.resolve() != path:
            raise ValueError(f'Media runtime source missing or symbolic: {path}')
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


class Transaction:
    def __init__(self):
        self.previous = {}

    def write(self, path, data, mode=0o644):
        path = Path(path)
        if path.is_symlink():
            raise ValueError(f'Refusing to replace symlink: {path}')
        if path not in self.previous:
            self.previous[path] = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
        try:
            temp.write_bytes(data)
            temp.chmod(mode)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)

    def rollback(self):
        for path, old in reversed(list(self.previous.items())):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(old[0])
                path.chmod(old[1])


def validate_object(path, fallback=None):
    value = json.loads(path.read_text()) if path.exists() else (fallback if fallback is not None else {})
    if not isinstance(value, dict):
        raise ValueError(f'Expected JSON object: {path}')
    return value


def linux_host_architecture():
    machine = platform.machine().lower()
    architecture = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(machine)
    if architecture is None:
        raise ValueError(f'Media mode supports Linux arm64/x64 hosts only; found {machine!r}')
    return architecture


def elf_architecture(path):
    # Inspect only the ELF header. Never run the executable or a dynamic loader
    # (including ldd) to identify an installation supplied by the caller.
    with path.open('rb') as binary:
        header = binary.read(64)
    if (len(header) != 64 or header[:7] != b'\x7fELF\x02\x01\x01' or
            int.from_bytes(header[20:24], 'little') != 1 or
            int.from_bytes(header[52:54], 'little') != 64):
        raise ValueError(f'Expected a complete ELF64 little-endian header: {path}')
    machine = int.from_bytes(header[18:20], 'little')
    architecture = {183: 'arm64', 62: 'x64'}.get(machine)
    if architecture is None:
        raise ValueError(f'Unsupported ELF architecture (e_machine={machine}): {path}')
    return architecture


def install(args):
    if sys.platform != 'linux':
        raise ValueError('The QQ AVSDK Host installer currently supports Linux only')
    if not args.qq_dir or not args.napcat_dir:
        raise ValueError('--qq-dir and --napcat-dir are required')
    qq = Path(args.qq_dir).resolve()
    napcat = Path(args.napcat_dir).resolve()
    target = Path(args.install_dir).resolve()
    app = qq / 'resources/app'
    loader = app / 'loadNapCat.js'
    backup = app / 'loadNapCat.koishi-rtc-qq.backup.cjs'
    plugin = napcat / 'plugins' / PLUGIN
    config_path = napcat / 'config/plugins.json'
    manifest_path = target / 'runtime/install-manifest.json'
    manifest = validate_object(manifest_path)
    if manifest and (manifest.get('qqDir') != str(qq) or manifest.get('napcatDir') != str(napcat)):
        raise ValueError('Existing install directory belongs to another QQ/NapCat; uninstall it first')
    if not (napcat / 'napcat.mjs').is_file() or not (napcat / 'config').is_dir():
        raise ValueError('NapCat directory must contain napcat.mjs and config/')
    if not (qq / 'qq').is_file() or not (app / 'package.json').is_file():
        raise ValueError('QQ installation is incomplete')
    package = validate_object(app / 'package.json')
    config = validate_object(config_path)
    if plugin.exists() and not manifest:
        raise ValueError('Plugin directory already exists without this installer manifest; refusing to overwrite')
    media = not args.diagnostics_only
    architectures = None
    if manifest.get('mediaEnabled') and not media:
        raise ValueError('Uninstall the media bridge before installing diagnostics-only mode')
    if media:
        if package.get('type') == 'module' or package.get('main') not in ('loadNapCat.js', './loadNapCat.js'):
            raise ValueError('Media mode requires a NapCat CommonJS loadNapCat.js entry; install NapCat in a separate compatible QQ first')
        if not (app / 'avsdk/libAVSDKPlugin.so').is_file():
            raise ValueError('QQ AVSDK library is missing. Use --diagnostics-only or supply a complete matching QQ installation; do not mix libraries across QQ versions')
        architectures = {'host': linux_host_architecture(), 'qq': elf_architecture(qq / 'qq'),
                         'avsdk': elf_architecture(app / 'avsdk/libAVSDKPlugin.so')}
        if len(set(architectures.values())) != 1:
            raise ValueError('QQ/AVSDK architecture mismatch '
                             f'(QQ={architectures["qq"]}, AVSDK={architectures["avsdk"]}, host={architectures["host"]}). '
                             'Supply a complete QQ installation matching this Linux host')
        if not loader.is_file():
            raise ValueError('QQ loader missing')
        content = loader.read_text()
        if 'AV_HOST' in content and MARKER not in content:
            raise ValueError('Another AV Host loader hook exists; restore its original loader before installing')
        if MARKER in content:
            if not manifest or not backup.is_file() or digest(loader.read_bytes()) != manifest.get('hookHash'):
                raise ValueError('Existing loader hook is not owned by this installation')
        elif backup.exists():
            raise ValueError('Refusing to overwrite an unrelated loader backup')
    audio_source = SOURCE.parent / 'audio'
    if not (audio_source / 'qq-pulse-guard.c').is_file():
        audio_source = SOURCE / 'audio'
    audio_files = ['qq-pulse-guard.c', 'build-qq-pulse-guard.mjs']
    media_runtime = media_runtime_files()
    node = os.environ.get('NODE_BIN', 'node')
    compiler = os.environ.get('CC', 'cc')
    if media:
        if not shutil.which(node) or not shutil.which(compiler):
            raise ValueError('Media mode requires Node.js and a native C compiler (cc/CC) to build the mandatory QQ PulseAudio guard on this architecture')
        if any(not (audio_source / name).is_file() for name in audio_files):
            raise ValueError('QQ PulseAudio guard source/builder missing; refusing unguarded media installation')
    plan = {'mode': 'media' if media else 'diagnostics-only', 'qqVersion': package.get('version'),
            'architectures': architectures,
            'qqDir': str(qq), 'napcatDir': str(napcat), 'installDir': str(target),
            'loaderChange': media, 'startsOrRestartsQQ': False,
            'audioShim': str(target / 'audio/qq-pulse-guard.so') if media else None,
            'audioShimBuildOnTarget': media}
    plan['mediaRuntimeFiles'] = list(MEDIA_RUNTIME_FILES)
    if args.check:
        print(json.dumps({'ok': True, 'plan': plan}, indent=2))
        return
    guard_binary = None
    if media:
        # Compile before changing any installed files, and never distribute a
        # host-built .so as portable code for another machine/architecture.
        with tempfile.TemporaryDirectory(prefix='koishi-rtc-pulse-build-') as temporary:
            output = Path(temporary) / 'qq-pulse-guard.so'
            result = subprocess.run([node, str(audio_source / 'build-qq-pulse-guard.mjs'), '--output', str(output)], capture_output=True, text=True)
            if result.returncode != 0:
                raise ValueError('QQ PulseAudio guard compilation failed; no installation files changed: ' + result.stderr[-1600:])
            guard_binary = output.read_bytes()
            if elf_architecture(output) != architectures['host']:
                raise ValueError('Compiled QQ PulseAudio guard does not match this Linux architecture')
    tx = Transaction()
    try:
        token_path = target / 'runtime/control.token'
        token = token_path.read_text().strip() if token_path.exists() else secrets.token_hex(32)
        if len(token.encode()) < 32:
            raise ValueError('Existing token has fewer than 32 bytes')
        tx.write(token_path, (token + '\n').encode(), 0o600)
        token_path.parent.chmod(0o700)
        tx.write(target / 'runtime/qq-dir', (str(qq) + '\n').encode(), 0o600)
        tx.write(target / 'runtime/napcat-dir', (str(napcat) + '\n').encode(), 0o600)
        tx.write(target / 'runtime/bridge-port', (str(args.port) + '\n').encode(), 0o600)
        tx.write(target / 'runtime/av-port', (str(args.av_port) + '\n').encode(), 0o600)
        for relative, source_file in media_runtime:
            destination = target / relative
            if source_file != destination:
                tx.write(destination, source_file.read_bytes())
        if media:
            for name in audio_files:
                tx.write(target / 'audio' / name, (audio_source / name).read_bytes())
            tx.write(target / 'audio/qq-pulse-guard.so', guard_binary, 0o755)
        managed = {}
        for item in sorted((SOURCE / 'napcat-plugin').glob('*')):
            if item.is_file() and item.suffix in ('.mjs', '.json'):
                data = item.read_bytes()
                tx.write(plugin / item.name, data)
                managed[item.name] = digest(data)
        for folder in ('scripts', 'av-host'):
            for item in sorted((SOURCE / folder).glob('*')):
                if item.is_file() and item.suffix in ('.sh', '.py', '.cjs', '.html'):
                    destination = target / folder / item.name
                    if item.resolve() != destination.resolve():
                        tx.write(destination, item.read_bytes(), 0o755 if item.suffix in ('.sh', '.py') else 0o644)
        if (SOURCE / 'ATTRIBUTION.md').resolve() != (target / 'ATTRIBUTION.md').resolve():
            tx.write(target / 'ATTRIBUTION.md', (SOURCE / 'ATTRIBUTION.md').read_bytes())
        bridge_config = {'controlHost': '127.0.0.1', 'controlPort': args.port,
                         'avHost': '127.0.0.1', 'avPort': args.av_port,
                         'mediaEnabled': media, 'tokenFile': str(token_path)}
        tx.write(plugin / 'bridge-config.json', encoded(bridge_config), 0o600)
        managed['bridge-config.json'] = digest(encoded(bridge_config))
        original = manifest.get('originalPluginEntry', {'exists': PLUGIN in config, 'value': config.get(PLUGIN)})
        config[PLUGIN] = True
        tx.write(config_path, encoded(config), stat.S_IMODE(config_path.stat().st_mode) if config_path.exists() else 0o600)
        hook_hash = manifest.get('hookHash')
        if media and MARKER not in loader.read_text():
            tx.write(backup, loader.read_bytes(), stat.S_IMODE(loader.stat().st_mode))
            hook = ('"use strict";\n// ' + MARKER + '\n'
                    'if (process.env.KOISHI_RTC_QQ_AV_HOST === "1") {\n'
                    '  require(process.env.KOISHI_RTC_QQ_AV_HOST_ENTRY || ' + json.dumps(str(target / 'av-host/host.cjs')) + ');\n'
                    '} else { require("./loadNapCat.koishi-rtc-qq.backup.cjs"); }\n').encode()
            tx.write(loader, hook, stat.S_IMODE(loader.stat().st_mode))
            hook_hash = digest(hook)
        result = {**plan, 'schemaVersion': 1, 'mediaEnabled': media, 'hookHash': hook_hash,
                  'originalPluginEntry': original, 'pluginFiles': managed,
                  'audioShimSHA256': digest(guard_binary) if guard_binary else None}
        tx.write(manifest_path, encoded(result), 0o600)
    except Exception:
        tx.rollback()
        raise
    print(json.dumps({'ok': True, 'installed': plan, 'tokenFile': str(token_path),
                      'next': 'No processes changed. Load the plugin only when ready for a separate QQ test.'}, indent=2))


def uninstall(args):
    target = Path(args.install_dir).resolve()
    manifest_path = target / 'runtime/install-manifest.json'
    manifest = validate_object(manifest_path)
    if manifest.get('schemaVersion') != 1:
        raise ValueError('Installation manifest missing; refusing unowned file deletion')
    app = Path(manifest['qqDir']) / 'resources/app'
    napcat = Path(manifest['napcatDir'])
    loader = app / 'loadNapCat.js'
    backup = app / 'loadNapCat.koishi-rtc-qq.backup.cjs'
    if manifest['mediaEnabled']:
        if not loader.is_file() or digest(loader.read_bytes()) != manifest['hookHash'] or not backup.is_file():
            raise ValueError('QQ loader changed or backup missing; nothing removed. Restore or inspect the backup manually')
    bootstrap_manifest = napcat / 'koishi-rtc-local-bootstrap.json'
    bootstrap_files = []
    if bootstrap_manifest.is_file():
        bootstrap_record = validate_object(bootstrap_manifest)
        expected_paths = {str(napcat / 'napcat.mjs'), str(backup)}
        bootstrap_files = bootstrap_record.get('files', [])
        if len(bootstrap_files) != 2 or {item.get('path') for item in bootstrap_files} != expected_paths:
            raise ValueError('Unexpected local bootstrap restoration paths')
        for item in bootstrap_files:
            dest, original = Path(item['path']), Path(item['backup'])
            if original != dest.with_name(dest.name + '.before-koishi-rtc-local-plugin') or not original.is_file() or \
                    digest(dest.read_bytes()) != item['patchedSHA256'] or digest(original.read_bytes()) != item['originalSHA256']:
                raise ValueError('Local bootstrap files changed; nothing removed. Review its manifest first')
    plugin = napcat / 'plugins' / PLUGIN
    retained = []
    removable = []
    for name, expected in manifest['pluginFiles'].items():
        if Path(name).name != name:
            raise ValueError('Invalid manifest path')
        item = plugin / name
        if item.is_file() and not item.is_symlink() and digest(item.read_bytes()) == expected:
            removable.append(item)
        elif item.exists():
            retained.append(str(item))
    if args.check:
        print(json.dumps({'ok': True, 'removeFiles': [str(p) for p in removable], 'retainedChangedFiles': retained, 'restoreLocalBootstrapFiles': [item['path'] for item in bootstrap_files]}, indent=2))
        return
    tx = Transaction()
    try:
        for item in bootstrap_files:
            tx.write(Path(item['path']), Path(item['backup']).read_bytes(), stat.S_IMODE(Path(item['path']).stat().st_mode))
        config_path = napcat / 'config/plugins.json'
        config = validate_object(config_path)
        baseline = manifest['originalPluginEntry']
        if baseline['exists']:
            config[PLUGIN] = baseline['value']
        else:
            config.pop(PLUGIN, None)
        tx.write(config_path, encoded(config), stat.S_IMODE(config_path.stat().st_mode) if config_path.exists() else 0o600)
        if manifest['mediaEnabled']:
            tx.write(loader, backup.read_bytes(), stat.S_IMODE(backup.stat().st_mode))
    except Exception:
        tx.rollback()
        raise
    for item in removable:
        item.unlink()
    try:
        plugin.rmdir()
    except OSError:
        pass
    if manifest['mediaEnabled']:
        backup.unlink()
    manifest_path.unlink()
    if bootstrap_files:
        bootstrap_manifest.rename(bootstrap_manifest.with_suffix('.restored.json'))
    print(json.dumps({'ok': True, 'retainedChangedFiles': retained,
                      'note': 'Loader/config restored. Runtime, token and logs retained; no processes stopped.'}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['install', 'uninstall'])
    parser.add_argument('--qq-dir')
    parser.add_argument('--napcat-dir')
    parser.add_argument('--install-dir', default=os.environ.get('KOISHI_RTC_QQ_BRIDGE_DIR', str(Path.home() / '.local/share/koishi-rtc-qq')))
    parser.add_argument('--diagnostics-only', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--port', type=int, default=6110)
    parser.add_argument('--av-port', type=int, default=6111)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.av_port <= 65535:
        parser.error('Ports must be in 1..65535')
    try:
        (install if args.operation == 'install' else uninstall)(args)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()

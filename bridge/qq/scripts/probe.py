#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Read-only QQ bridge file probe. Does not import QQ code or touch accounts."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import struct


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qq-dir', required=True)
    parser.add_argument('--napcat-dir')
    args = parser.parse_args()
    qq = Path(args.qq_dir).resolve()
    app = qq / 'resources/app'
    package = {}
    try:
        package = json.loads((app / 'package.json').read_text())
    except (OSError, ValueError):
        pass
    library = app / 'avsdk/libAVSDKPlugin.so'
    lib = {'present': library.is_file(), 'architecture': None, 'sha256': None}
    if library.is_file():
        with library.open('rb') as f:
            header = f.read(64)
            if header[:4] == b'\x7fELF' and len(header) >= 20:
                machine = struct.unpack(('<' if header[5] == 1 else '>') + 'H', header[18:20])[0]
                lib['architecture'] = {183: 'arm64', 62: 'x64'}.get(machine, f'ELF machine {machine}')
            f.seek(0)
            lib['sha256'] = hashlib.file_digest(f, 'sha256').hexdigest()
    commands = {name: shutil.which(name) is not None for name in ['python3', 'pulseaudio', 'pactl', 'parec', 'pacat', 'xvfb-run', 'curl', 'flock']}
    blockers = []
    if not library.is_file():
        blockers.append('AVSDK_MISSING: this QQ distribution cannot run the AV Host; a complete matching installation is required')
    if package.get('type') == 'module' or package.get('main') not in ['./loadNapCat.js', 'loadNapCat.js']:
        blockers.append('NAPCAT_LOADER_MISSING: media installer requires a CommonJS NapCat entry in a separate QQ installation')
    if platform.system() != 'Linux':
        blockers.append('LINUX_ONLY: the current AV Host launcher is Linux-specific')
    arch = {'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine(), platform.machine())
    if lib['architecture'] and lib['architecture'] != arch:
        blockers.append('ARCH_MISMATCH: AVSDK does not match this machine')
    if not all(commands.values()):
        blockers.append('DEPENDENCIES_MISSING: inspect commands')
    print(json.dumps({'probeOnly': True, 'runtimeTested': False, 'platform': platform.system(),
                      'arch': arch, 'qqVersion': package.get('version'), 'qqEntry': package.get('main'),
                      'library': lib, 'commands': commands, 'blockers': blockers,
                      'nativeDialOrGroupSupport': 'requires verified command/parameter profile and an actual call test'}, indent=2))


if __name__ == '__main__':
    main()

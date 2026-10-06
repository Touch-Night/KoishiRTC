#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Read-only QQ.app Mach-O probe; never loads an application or native library."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import struct

AUDITED_SHA256 = '8dcddc9ade6120ba1fecb7f8961d401dded8c4881ce3e12b5a023465089c64c6'
ARCHES = {0x01000007: 'x64', 0x0100000c: 'arm64'}


def macho(file):
    data = Path(file).read_bytes()
    if len(data) < 8:
        raise ValueError('truncated Mach-O')
    if data[:4] == b'\xca\xfe\xba\xbe':
        count = struct.unpack_from('>I', data, 4)[0]
        if count > 32 or 8 + count * 20 > len(data):
            raise ValueError('invalid universal Mach-O header')
        slices = [struct.unpack_from('>IIIII', data, 8 + i * 20)[2:4] for i in range(count)]
    elif data[:4] == b'\xcf\xfa\xed\xfe':
        slices = [(0, len(data))]
    else:
        raise ValueError('expected universal or little-endian 64-bit Mach-O')
    result = []
    for offset, size in slices:
        if offset + size > len(data) or size < 32:
            raise ValueError('invalid Mach-O slice bounds')
        b = memoryview(data)[offset:offset + size]
        magic, cpu, subtype, filetype, commands, commandbytes, flags, reserved = struct.unpack_from('<8I', b)
        if magic != 0xfeedfacf or commands > 4096 or 32 + commandbytes > size:
            raise ValueError('invalid Mach-O load commands')
        p, dependencies, rpaths, exports = 32, [], [], []
        for _ in range(commands):
            if p + 8 > 32 + commandbytes:
                raise ValueError('truncated load command')
            cmd, length = struct.unpack_from('<II', b, p)
            if length < 8 or p + length > 32 + commandbytes:
                raise ValueError('invalid load command size')
            if cmd in (0xc, 0x80000018, 0x8000001f, 0x8000001c):
                if length < 12:
                    raise ValueError('truncated library command')
                name_at = struct.unpack_from('<I', b, p + 8)[0]
                if name_at >= length:
                    raise ValueError('invalid library name')
                name = bytes(b[p + name_at:p + length]).split(b'\0', 1)[0].decode('utf-8', errors='replace')
                (rpaths if cmd == 0x8000001c else dependencies).append(name)
            if cmd == 2:
                if length < 24:
                    raise ValueError('truncated symbol table')
                symoff, count, stroff, strsize = struct.unpack_from('<4I', b, p + 8)
                if symoff + 16 * count > size or stroff + strsize > size:
                    raise ValueError('invalid symbol table bounds')
                strings = bytes(b[stroff:stroff + strsize])
                for i in range(count):
                    idx, kind, section, desc, address = struct.unpack_from('<IBBHQ', b, symoff + i * 16)
                    if idx >= strsize:
                        continue
                    end = strings.find(b'\0', idx)
                    name = strings[idx:end if end >= 0 else strsize]
                    if address and name in (b'_PPP_GetInterface', b'_PPP_InitializeModule', b'_PPP_ShutdownModule'):
                        exports.append(name.decode())
            p += length
        result.append({'arch': ARCHES.get(cpu, hex(cpu)), 'sliceSHA256': hashlib.sha256(b).hexdigest(),
                       'dependencies': dependencies, 'rpaths': rpaths, 'pepperExports': sorted(exports)})
    return {'sha256': hashlib.sha256(data).hexdigest(), 'slices': result}


def inspect(app):
    app = Path(app).expanduser().resolve()
    result = {'app': str(app), 'runtimeTested': False, 'hostPlatform': platform.system(),
              'hostArchitecture': platform.machine(), 'blockers': [], 'warnings': []}
    try:
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        package = json.loads((app / 'Contents/Resources/app/package.json').read_text())
        result.update(qqVersion=package.get('version'), buildVersion=package.get('buildVersion'),
                      bundleIdentifier=info.get('CFBundleIdentifier'), entry=package.get('main'),
                      microphoneUsageDescription=bool(info.get('NSMicrophoneUsageDescription')),
                      cameraUsageDescription=bool(info.get('NSCameraUsageDescription')))
        executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
        result['executable'] = macho(executable)
        sdk = app / 'Contents/Resources/app/avsdk/libAVSDKPlugin.dylib'
        result['avsdk'] = macho(sdk)
        result['auditedLibrary'] = result['avsdk']['sha256'] == AUDITED_SHA256 and package.get('version') == '7.0.2-53644'
        for arch in result['avsdk']['slices']:
            if len(arch['pepperExports']) != 3:
                result['blockers'].append(f"{arch['arch']}: AVSDK lacks required Pepper exports")
        avdir = sdk.parent
        for relative in ['TXFFmpeg.framework/Versions/A/TXFFmpeg', 'TXSoundTouch.framework/Versions/A/TXSoundTouch']:
            if not (avdir / relative).is_file():
                result['blockers'].append('Missing AVSDK dependency: ' + relative)
        framework = app / 'Contents/Frameworks/QQNT.framework/Versions/A/Resources/Info.plist'
        if framework.is_file():
            result['electron'] = plistlib.loads(framework.read_bytes()).get('CFBundleVersion')
        if not result['auditedLibrary']:
            result['warnings'].append('This exact QQ/AVSDK build has not been statically audited.')
        result['warnings'].append('A matching Pepper export is load evidence, not proof of login or calls; native command/callback profile remains gated until Mac verification.')
    except (OSError, ValueError, KeyError, struct.error) as error:
        result['blockers'].append(str(error))
    result['tools'] = {tool: bool(shutil.which(tool)) for tool in ['python3', 'codesign', 'ditto', 'node']}
    if platform.system() != 'Darwin':
        result['warnings'].append('Static inspection only on this operating system; Mac launch/signature/TCC checks were not run.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qq-app', required=True)
    args = parser.parse_args()
    report = inspect(args.qq_app)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    raise SystemExit(1 if report['blockers'] else 0)

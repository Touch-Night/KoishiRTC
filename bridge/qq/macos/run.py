#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Explicitly start one Mac process; installing never launches or logs into QQ."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from install import owned_directory, validate_bootstrap


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', required=True)
    parser.add_argument('mode', choices=['host', 'napcat', 'gui', 'status'])
    parser.add_argument('--qq-microphone', default='BlackHole 2ch', choices=['BlackHole 2ch', 'BlackHole 16ch'])
    parser.add_argument('--qq-speaker', default='BlackHole 16ch', choices=['BlackHole 2ch', 'BlackHole 16ch'])
    parser.add_argument('--media', action='store_true', help='Enable native bridge forwarding for the NapCat process; this is not a verified-call flag.')
    args = parser.parse_args()
    root = owned_directory(args.install_dir)
    cfg = json.loads((root / 'macos-install.json').read_text())
    if cfg.get('format') != 'koishi-rtc-macos-v1':
        raise SystemExit('Not a Koishi RTC Mac installation')
    if args.mode == 'status':
        import urllib.request
        token = (root / 'runtime/control.token').read_text().strip()
        report = {'runtimeTestedByThisScript': False}
        for key, port in [('bridge', cfg['bridgePort']), ('host', cfg['avPort'])]:
            req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/status', headers={'Authorization': 'Bearer ' + token})
            try:
                report[key] = json.load(urllib.request.urlopen(req, timeout=5))
            except Exception as error:
                report[key] = {'error': str(error)}
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    if args.mode == 'napcat':
        validate_bootstrap(root)
        flags = json.loads((root / 'napcat/config/plugins.json').read_text())
        if flags.get('napcat-plugin-koishi-rtc-qq') is not True:
            raise SystemExit('Enable napcat-plugin-koishi-rtc-qq in this installation\'s config/plugins.json before starting.')
    if platform.system() != 'Darwin':
        raise SystemExit('Launching QQ requires macOS; no process was started.')
    if args.qq_microphone == args.qq_speaker:
        raise SystemExit('QQ microphone and speaker require different BlackHole devices.')
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env.update(KOISHI_RTC_QQ_AUDIO_INPUT_NAME=args.qq_microphone,
               KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME=args.qq_speaker,
               KOISHI_RTC_QQ_BRIDGE_DIR=str(root / 'bridge/qq'),
               KOISHI_RTC_QQ_QQ_DIR=str(root / 'QQ-RTC.app/Contents'),
               KOISHI_RTC_QQ_AVSDK_PATH=str(root / 'QQ-RTC.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib'),
               KOISHI_RTC_QQ_BRIDGE_TOKEN_FILE=str(root / 'runtime/control.token'),
               KOISHI_RTC_QQ_BRIDGE_PORT=str(cfg['bridgePort']), KOISHI_RTC_QQ_AV_HOST_PORT=str(cfg['avPort']),
               KOISHI_RTC_QQ_MEDIA_ENABLED='1' if args.media else '0',
               KOISHI_RTC_QQ_AV_HOST='1' if args.mode == 'host' else '0',
               KOISHI_RTC_QQ_LOAD_NAPCAT='1' if args.mode == 'napcat' else '0')
    executable = root / 'QQ-RTC.app/Contents/MacOS' / cfg['executable']
    command = [str(executable)]
    if args.mode != 'gui':
        command.append('--no-sandbox')
    command += ['--user-data-dir=' + str(root / 'runtime' / (args.mode + '-profile'))]
    # Only this foreground child is managed; Ctrl-C does not kill other QQ processes.
    try:
        child = subprocess.Popen(command, env=env, cwd=root)
        try:
            return child.wait()
        except KeyboardInterrupt:
            child.terminate()
            try:
                return child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                return child.wait()
    except OSError as error:
        raise SystemExit(str(error))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit('Error: ' + str(error))

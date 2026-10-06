#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""Enumerate and validate the two virtual routes without opening audio streams."""
import argparse
import json
from pathlib import Path
import sys


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--qq-microphone', default='BlackHole 2ch', choices=['BlackHole 2ch', 'BlackHole 16ch'])
    p.add_argument('--qq-speaker', default='BlackHole 16ch', choices=['BlackHole 2ch', 'BlackHole 16ch'])
    args = p.parse_args()
    if args.qq_microphone == args.qq_speaker:
        raise ValueError('QQ microphone and speaker must use different BlackHole devices.')
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'audio'))
    from portaudio_worker import enumerate_devices
    import sounddevice as sd
    devices = enumerate_devices(sd)
    def choose(name, direction):
        matches = [d for d in devices if d['name'] == name and d['direction'] == direction and d['hostApi'] == 'Core Audio']
        if len(matches) != 1:
            raise ValueError(f'Expected one Core Audio {direction} endpoint named {name}; found {len(matches)}.')
        return matches[0]
    receive = choose(args.qq_speaker, 'input')
    transmit = choose(args.qq_microphone, 'output')
    sd.check_input_settings(device=receive['index'], channels=1, dtype='int16', samplerate=48000)
    sd.check_output_settings(device=transmit['index'], channels=1, dtype='int16', samplerate=48000)
    print(json.dumps({'opensAudioStreams': False, 'runtimeCallTested': False,
      'qqHostEnvironment': {'KOISHI_RTC_QQ_AUDIO_INPUT_NAME': args.qq_microphone,
                            'KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME': args.qq_speaker},
      'audio': {'backend': 'portaudio', 'python': sys.executable,
                'inputDevice': receive['id'], 'outputDevice': transmit['id'],
                'sampleRate': 48000, 'channels': 1, 'frameMs': 20, 'maxQueueMs': 2000}}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error), 'opensAudioStreams': False}), file=sys.stderr)
        sys.exit(1)

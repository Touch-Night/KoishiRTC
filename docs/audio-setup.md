# Desktop virtual audio setup

The bridge supports Linux (PulseAudio or PipeWire-Pulse), Windows, and macOS. It does not install virtual audio drivers, change the system default microphone, or change QQ's device settings. Call control and virtual audio routing are separate requirements; these instructions establish only the audio path.

## Two separate routes

Use two independent virtual routes, not one cable looped back into itself:

```text
QQ speaker output → virtual route RX → bridge inputDevice → received PCM
outgoing PCM → bridge outputDevice → virtual route TX → QQ microphone input
```

Do not select a physical microphone, the system-wide speaker loopback, or an OS default device. A mixed group-call output remains mixed: this backend does not identify participants or separate overlapping voices.

The bridge requires explicit device identities. Missing or ambiguous devices fail startup; device loss stops the backend. There is no automatic retry on a default device. Use device enumeration again after intentionally changing drivers, and explicitly restart the session.

## Linux: PulseAudio / PipeWire-Pulse

Install `pactl`, `parec`, `pacat`, and a C compiler. Debian/Ubuntu package names are `pulseaudio-utils` and `build-essential`. PipeWire needs its PulseAudio-compatible service (`pipewire-pulse`); do not replace an existing sound server just to run this bridge.

Build the small device-pinning shim once on the Linux machine:

```sh
node bridge/audio/build-pulse-shim.mjs
```

This produces `bridge/audio/pulse-no-move.so`. The shim adds `PA_STREAM_DONT_MOVE` to the two PulseAudio connection calls. Stock `parec`/`pacat` have no CLI option for this flag: choosing `--device` alone does not prevent a server from moving a stream when that device disappears. Only these audio child processes receive the shim in their `LD_PRELOAD` environment. Startup refuses to record if it is missing or fails to load. Rebuild on a different architecture; do not copy this `.so` between incompatible machines. The compiler is an installation requirement, not a per-call requirement.

The isolated **QQ AVHost** also needs its own guard, `qq-pulse-guard.so`. The Linux QQ installer builds it locally; a manual build is `node bridge/audio/build-qq-pulse-guard.mjs`, optionally followed by `--output /absolute/path/qq-pulse-guard.so`. Source distributions and npm packages exclude compiled `.so` files, so a C compiler is required on each target Linux machine. This library belongs only in the AVHost child environment, never in a global `LD_PRELOAD` or the desktop's normal QQ launcher.

The AVHost guard requires `PULSE_SERVER=unix:/absolute/private/socket`, `KOISHI_RTC_QQ_PULSE_SOURCE=koishi_rtc_qq_mic_source`, and `KOISHI_RTC_QQ_PULSE_SINK=koishi_rtc_qq_speaker`. It rejects other servers/devices, disables Pulse daemon autospawn, and pins streams against device moves. `PULSE_LATENCY_MSEC` must be unset because libpulse would otherwise replace the guard's capture fragment size. The launcher accepts `KOISHI_RTC_QQ_AUDIO_SHIM_PATH` to select the compiled guard explicitly.

QQ's native Linux library passes no buffer attributes, which caused approximately two-second microphone capture batches in the tested private null sinks. The guard requests at most 60 ms playback buffering, 20 ms capture fragments, and 240 ms maximum stream storage, while preserving smaller valid explicit requests. At QQ's observed 44.1 kHz stereo PCM16 format, a 20 ms capture fragment is 3,528 bytes. These are requested values: confirm the negotiated `pactl list source-outputs` buffer latency during a call and check that recurring `NotifyBuffer interval exceed` warnings disappear. A shim log is not evidence that a remote participant heard audio. PulseAudio documents the [buffer latency behavior](https://raw.githubusercontent.com/pulseaudio/pulseaudio/v16.1/src/pulse/def.h) and its [environment-variable override](https://raw.githubusercontent.com/pulseaudio/pulseaudio/v16.1/src/pulse/stream.c).

An isolated Linux ARM64 / PulseAudio 16.1 check with two null sinks and generated silence measured 20.249 ms capture buffering and 50.171 ms playback buffering plus 8.433 ms sink latency after four seconds. A newly created null sink can retain its initial two-second scheduled block briefly after the request changes; inspect steady-state actual latency as well as the configured value. This local check does not validate QQ group signaling or remote audio delivery. The offline test `node --import tsx --test test/audio-qq-pulse-guard.test.ts` also covers Chromium's locally loaded plugin/dependency scope, device rejection, buffer limits, and preservation of smaller explicit requests.

For a temporary two-route setup, these commands create virtual devices; run them only when ready to configure the local audio session:

```sh
pactl load-module module-null-sink sink_name=rtc_rx sink_properties=device.description=KoishiRTC_RX
pactl load-module module-null-sink sink_name=rtc_tx sink_properties=device.description=KoishiRTC_TX
pactl load-module module-remap-source master=rtc_tx.monitor source_name=rtc_mic source_properties=device.description=KoishiRTC_Microphone
```

Each command prints a module ID. Keep the IDs if you want to remove exactly those modules later with `pactl unload-module ID`. Persistence across logout/reboot depends on your sound-server configuration and is not changed by the bridge.

Select **KoishiRTC_RX** as QQ's speaker output and **KoishiRTC_Microphone** as QQ's microphone. If QQ cannot select devices directly, explicitly route its own streams in the system audio manager; do not change every application's default devices.

Backend configuration:

```json
{
  "backend": "pulse",
  "inputDevice": "rtc_rx.monitor",
  "outputDevice": "rtc_tx",
  "sampleRate": 48000,
  "channels": 1,
  "frameMs": 20,
  "maxQueueMs": 2000
}
```

Optional fields are `pulseServer`, executable paths `pactl`/`parec`/`pacat`, and `noMoveShim`. The bridge sets a fixed `s16le` stream format; it does not use `--fix-format` or `--fix-rate` to silently change the protocol. The sound server may resample its device side.

## Windows and macOS: isolated PortAudio worker

Use Python 3.10 or newer and a dedicated environment:

```sh
python -m venv .venv-rtc-audio
# Activate that environment, then:
python -m pip install -r bridge/audio/requirements.txt
```

On Windows, the environment's interpreter is `.venv-rtc-audio\Scripts\python.exe`; on macOS it is `.venv-rtc-audio/bin/python`. Set `python` to the absolute path of that interpreter in backend configuration. The `sounddevice` pip distributions install PortAudio on Windows/macOS; no NumPy dependency is needed because the worker uses raw streams. Virtual cable drivers are separate OS installations and are not included. See the upstream [sounddevice installation documentation](https://python-sounddevice.readthedocs.io/en/latest/installation.html).

Install/configure **two independent virtual audio routes**, then assign the RX route to QQ speaker output and the TX route to QQ microphone input. Select the RX recording endpoint for this bridge's input and the TX playback endpoint for its output. On Windows, capture/playback endpoints may have confusing inverse cable names; use their **direction** in the device list. On macOS, separate virtual devices or a routing application's separate buses are required. One duplex virtual device used on both sides would create a feedback path and is rejected.

Grant the selected Python executable microphone/audio-input permission where the OS requests it. This permission permits capture from the chosen virtual input; the bridge still does not select the real microphone. QQ's own device permission and routing must also work independently.

Enumerate devices without recording or playback:

```sh
.venv-rtc-audio/bin/python bridge/audio/portaudio_worker.py --list
# Windows: use .venv-rtc-audio\Scripts\python.exe instead.
```

Choose the full `pa:...` identifiers from the appropriate `input`/`output` entries. They encode the exact host API and device name, not an unstable numeric device index. Duplicate matches are rejected rather than selecting an arbitrary device. Example configuration shape:

```json
{
  "backend": "portaudio",
  "python": "/absolute/path/to/.venv-rtc-audio/bin/python",
  "inputDevice": "pa:identifier-from-input-list",
  "outputDevice": "pa:identifier-from-output-list",
  "sampleRate": 48000,
  "channels": 1,
  "frameMs": 20,
  "maxQueueMs": 2000
}
```

The worker checks that both selected endpoints support the requested sample rate/channel count. Unsupported formats fail instead of changing the wire format. Choose matching device formats in OS settings or explicitly resample audio before passing it to the bridge. WASAPI/CoreAudio/driver behavior still requires real-machine validation; this implementation's automated tests use fake processes and a fake PortAudio callback clock, not a physical microphone or speaker.

## ESM API and receipts

Import `createAudioBackend` from `bridge/audio/index.mjs`. It returns an `EventEmitter` with these methods:

| Method | Meaning |
| --- | --- |
| `listDevices()` | Returns explicit device IDs and input/output directions; does not open audio streams. |
| `diagnostics()` | Dependency, route, and completion-semantics checks; does not record/play. |
| `start()` / `stop()` | Start capture/output service, or cancel pending output and close it. |
| `write(bytesOrAudioFrame, playbackId)` | Accept aligned PCM bytes; returns a receipt. Full `AudioFrame` format must match configuration. |
| `flush()` | Wait for the output submitted before this boundary to finish at the selected local endpoint. Await this before subsequent writes. |
| `clear()` | Cancel queued/in-flight output while leaving capture running; already emitted sound cannot be recalled. |
| `setMuted(true)` | Cancel pending output and reject new writes until unmuted. Capture remains active. |

Events: `audio` carries `{ data: Buffer, sampleRate, channels, encoding: 'pcm_s16le', sequence, timestamp }`; `playback` carries `{ id, acceptedBytes, playedBytes, state, evidence?, error? }` and retains a supplied `callId`; `error` carries an `Error`. Capture `timestamp` is local frame-delivery time, not a remote speaker's original clock. Subscribe to `error` and stop the corresponding call after a backend failure.

All output is little-endian signed PCM16, interleaved when stereo. The unsent queue is bounded by `maxQueueMs` (default 2 seconds, configurable up to 10 seconds). Each write must also fit that bound. A separate 60-second/4096-item limit bounds unconfirmed receipt metadata. PortAudio's worker also bounds its command and capture-event queues; an overrun stops audio instead of silently building an unlimited delay. Producers must handle queue-full rejection rather than dropping speech silently or retrying the whole utterance after a partially played result.

`acceptedBytes` means accepted by the bridge, not heard. `playedBytes` is a conservative device-side confirmation:

- **PulseAudio:** writing to `pacat`'s pipe does not increment it. A continuous series of writes shares a stream. `flush()` or an idle gap (default 100 ms, configurable as `idleDrainMs`) closes its input; only the explicit native stream-drained notification followed by successful exit confirms playback. Thus progress may remain zero while audio is already playing. Larger idle gaps start a new output stream and may introduce a small transition gap. Call `flush()` at utterance boundaries for prompt completion.
- **PortAudio:** bytes are confirmed only after a subsequent callback's device clock passes the scheduled DAC end time. Enqueueing or copying into an output buffer is not completion. A device discontinuity stops the worker; invalid DAC clocks cannot produce a successful receipt. See upstream [callback timestamps and stream lifecycle](https://python-sounddevice.readthedocs.io/en/latest/api/streams.html).

Neither mechanism proves QQ accepted the virtual-microphone audio or that another participant heard it. A cancelled/failed receipt may report a confirmed prefix; remaining bytes have uncertain delivery, so automatic resend is unsafe. Device mute here controls bridge output; it does not click QQ's own mute control.

## Validation checklist

Automated validation: `npx tsx --test test/audio-backends.test.ts`. These tests do not connect to an audio server, record a microphone, or produce sound. The Python callback test only imports the worker and passes byte arrays through a fake device clock.

On each target desktop OS, separately verify device enumeration, fixed routing, two-way direct calls, two-way group calls, interruption/clear, input/output device removal, and explicit recovery. Confirm that removing a virtual device ends audio instead of selecting the system default. Platform-specific call controls are outside this audio backend; passing an audio test alone does not establish QQ call support.

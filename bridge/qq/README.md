# QQ control bridge

This directory contains a standalone NapCat plugin, an optional QQ AVSDK
Host and reversible installers.
Nothing in the installer starts, restarts or logs into QQ. See
[compatibility and remaining checks](../../docs/qq-compatibility.md).

The AVSDK Host and confirmed login/Accept transport derive from
ClaudiaGardner/maibot-qq-voice-call 0.3.4. Changes are GPL-3.0-only; see
[ATTRIBUTION.md](ATTRIBUTION.md). Proprietary QQ binaries are not included.

## File diagnostics

```sh
python3 bridge/qq/scripts/probe.py --qq-dir /path/to/QQ
```

This inspects files, library architecture/hash and local command availability.
It never loads the QQ library. A successful probe execution does not mean calls
have been tested. `blockers` explains missing prerequisites.

## Observation-only plugin

Use this when the QQ package has no AVSDK or before enabling media. The plugin
observes native event names and shapes, reports actual account identity and
capabilities, and never logs in an AV Host, forwards native traffic or accepts
a call. Native strings, credentials and payloads are not returned as diagnostics.

```sh
bridge/qq/scripts/install.sh --qq-dir /path/to/QQ \
  --napcat-dir /path/to/napcat --diagnostics-only --check
bridge/qq/scripts/install.sh --qq-dir /path/to/QQ \
  --napcat-dir /path/to/napcat --diagnostics-only
```

Use an independent test installation. Load the installed plugin through that
NapCat instance only when ready. The existing live QQ is not changed by building
this repository.

## Media installation

Supply a complete Linux QQ installation with its matching `avsdk/libAVSDKPlugin.so`
and a CommonJS NapCat `resources/app/loadNapCat.js` entry. Do not copy a library
from a newer QQ into an older installation. The installer keeps the exact loader
backup and writes a small marked hook for a second QQ/Electron process.

Linux x64 and ARM64 have separate exact QQ `3.2.34-53644` native profiles.
The installer checks that QQ, AVSDK and this machine have the same ELF64
architecture before compiling the audio guard or writing installation files.
Use a complete official package for the target architecture. See the
[pinned packages and hashes](../../docs/qq-compatibility.md); x64 support is
statically audited and still requires real private/group and duplex audio tests.

```sh
bridge/qq/scripts/install.sh --qq-dir /path/to/test-QQ \
  --napcat-dir /path/to/test-napcat --check
bridge/qq/scripts/install.sh --qq-dir /path/to/test-QQ \
  --napcat-dir /path/to/test-napcat
```

Runtime defaults to `~/.local/share/koishi-rtc-qq`; `--install-dir`, `--port` and
`--av-port` override it. A generated token is stored with mode 0600 at
`runtime/control.token`; the installer prints its path, never its value.

When explicitly starting the separate test account:

```sh
KOISHI_RTC_QQ_BOT_UIN=123456789 \
  ~/.local/share/koishi-rtc-qq/scripts/run-napcat.sh
~/.local/share/koishi-rtc-qq/scripts/doctor.sh --runtime
```

Dependencies: Node.js, a native C compiler (`cc` or `CC`), Python 3, Xvfb,
PulseAudio, `pactl`, `parec`, `pacat`, `curl`, `flock`. Media installation compiles
`audio/qq-pulse-guard.so` on the target architecture before changing installed
files. Missing tools or failed compilation stop installation. Source and builder
are installed beside the generated library; portable/npm packages contain no
precompiled `.so`. `doctor.sh` checks its ELF architecture and recorded hash.
The launcher's default guard is `<install-dir>/audio/qq-pulse-guard.so`;
`KOISHI_RTC_QQ_AUDIO_SHIM_PATH` selects an explicit alternate build. The guard is
loaded only into the separate QQ AV Host and its child processes, with explicit
virtual source/sink names. It limits default PulseAudio buffering and forbids
context/device fallback; the Xvfb server and desktop audio environment are not
changed.
The launcher creates an isolated user-only PulseAudio socket and these devices:

| Direction | Device |
| --- | --- |
| Remote QQ audio → capture | `koishi_rtc_qq_speaker.monitor` |
| Bot PCM → playback | `koishi_rtc_qq_mic` |
| QQ microphone source | `koishi_rtc_qq_mic_source` |

The media daemon must use this socket (`unix:<install-dir>/runtime/pulse/native`)
and the indicated devices. The PCM bridge is separate from this HTTP control
protocol. A room-entry callback does not verify two-way audio by itself.

For native Windows and macOS installations, follow [Windows setup](../../docs/qq-windows.md)
and [macOS setup](../../docs/qq-macos.md). The shared Host loads the matching
DLL/dylib and checks the exact audited profile. Both platforms must select and
confirm separate virtual microphone/speaker devices before starting a call.
Windows uses authenticated Host `GET /v1/audio/devices`, then
`POST /v1/audio/route` with `{input:{id,name},output:{id,name}}`. Mac uses the
explicit BlackHole device names in its launcher. Restarting the Host requires
fresh routing confirmation. These platforms still require live call validation.

## Independent Linux test copy

```sh
python3 bridge/qq/scripts/prepare-linux-test.py \
  --qq-source /path/to/complete-official-QQ \
  --napcat-source /path/to/napcat-distribution \
  --target /path/to/new-empty-experiment --port 6120 --av-port 6121
```

This copies program files and required imported chunks, redirects native QQ
account data only in the new NapCat bundle, and preserves the original bundle
and hashes. It copies no account state and starts no process. Electron profile
flags alone do not isolate QQ native data. The same account must be switched
with an explicit coordinated logout/stop and login; do not run it concurrently.

## Distribution plugin allowlist

Some NapCat distributions reject every ID outside a hard-coded official plugin
set even when `plugins.json` enables a custom plugin. The independent Linux test
preparer detects this variant and installs an explicit local bootstrap for this
plugin only. It does not rename the plugin or change the official allowlist.

The bootstrap executes inside NapCat's actual worker after normal plugin scans,
then uses the existing plugin manager context and cleanup lifecycle. NapCat's
`utilityProcess.fork(napcat.mjs)` worker does not inherit JavaScript globals from
the Electron parent loader, so the worker initializes its own bootstrap.

For an already prepared independent copy, install explicitly with:

```sh
python3 bridge/qq/scripts/enable-local-plugin.py \
  --napcat-dir /path/to/test-napcat \
  --loader /path/to/test-QQ/resources/app/loadNapCat.koishi-rtc-qq.backup.cjs
```

The script validates the exact scan structure, preserves original bytes and
hashes in `koishi-rtc-local-bootstrap.json`, and starts no processes. Restart
only the separate NapCat worker to load the change; AV Host need not restart.
Normal plugin enable/disable configuration remains authoritative. `--restore`
reverts unchanged managed files. The Linux uninstaller also restores this
bootstrap before restoring its loader; altered files require manual review.

## HTTP protocol v1

Except `GET /healthz`, every endpoint requires `Authorization: Bearer <token>`.
Both bridge and AV Host bind to loopback only. A remote application connects
through the authenticated Koishi RTC daemon; it must not expose these internal
native endpoints directly.

Success envelope: `{ "ok": true, "protocolVersion": 1, "data": ... }`.
Errors: `{ "ok": false, "error": { "code": "...", "message": "...", "capability": "..." } }`.

| Endpoint | Response/request |
| --- | --- |
| `GET /v1/capabilities` | `selfId`, `selfUid`, platform, arch, bootId, capability map |
| `GET /v1/status` | Actual QQ identity, plugin/host readiness, call, diagnostics counters |
| `GET /v1/calls/current` | `null` or the current call object |
| `GET /v1/events?after=0&bootId=...` | `{bootId,events,nextSeq,reset,gap}` |
| `GET /v1/groups/current` | `{known,groups,current,joinExistingIsAtomic:false,activityMaxAgeMs}` |
| `POST /v1/calls/accept` | `{requestId,callId}` |
| `POST /v1/calls/reject` | `{requestId,callId}` |
| `POST /v1/calls/hangup` | `{requestId,callId}` |
| `POST /v1/calls/dial` | `{requestId,peerUid}` or `{requestId,peerUin}`; verifies native UID/UIN binding |
| `POST /v1/groups/join` | `{requestId,groupId}`; requires a fresh active audio group notification |
| `POST /v1/groups/leave` | `{requestId,callId}`; actual group Quit path |

`selfId` is the real UIN from NapCat `core.selfInfo`, not a value from bridge
configuration. The daemon must compare it to the selected account before any
control. Missing identity is `null`, never a guessed or configured account.

Capability entries are `{status: "supported"|"unavailable"|"unverified", reason,
evidence}`. Supported means an implemented driver with the required native
profile/readiness; it is not a claim of a successful live test. Unsupported
operations return 501; missing runtime prerequisites return 503.

A call contains `id`, `kind`, `direction`, `phase`, caller UID/UIN, timestamps,
`acceptReady`, `participants`, `participantsKnown`, `participantsSource`, and
`nativeRoom`. Native UIDs are not QQ numbers; participants are not inferred
speakers. Join/leave observations alone never claim a complete roster.

Events carry `{seq,at,type,...}`. `call.state` contains `call`, and
`control.receipt` contains a receipt. Persist both `bootId` and `nextSeq`.
On `gap` or `reset`, fetch current state before acting on events.

Control receipts contain `{requestId,callId,operation,status,submittedAt}`.
`submitted` (HTTP 202) only confirms submission to AVSDK. Native acknowledgement
can move it to `confirmed` or `failed`; delivery uncertainty returns `unknown`
(HTTP 202). Room connection/end remains a separate lifecycle state. Repeating
the same requestId returns its retained receipt and never resends the command.
Unknown results reserve the call; use native events to reconcile, not a new ID.

Group invitations are exposed as `group.invitation` observations and as
`groups/current.invitations`. They do not occupy the active call slot, invoke
Accept or imply group membership; explicit `group.join` performs the real join.

Group state lists actual native activity notifications. A group join requires
nonzero onlineCount, audio business type, no native timeout and local observation
within 60 seconds. Duplicate notifications do not extend freshness. Native
StartCall cannot atomically guarantee that the room still exists; the API
reports `joinExistingIsAtomic: false` rather than inventing a parameter.

The internal `/v1/avsdk/output` and Host `/v1/invoke` endpoints are not provider
APIs. They carry private native data within the same trusted machine.

## Uninstall

Stop the separate test bridge before uninstalling. This does not stop processes:

```sh
~/.local/share/koishi-rtc-qq/scripts/uninstall.sh --check
~/.local/share/koishi-rtc-qq/scripts/uninstall.sh
```

The installer restores the exact loader and the previous NapCat plugin flag,
while preserving other plugins' settings. If QQ upgrades changed the loader,
uninstallation refuses to overwrite it. Changed plugin files are retained and
reported. Runtime, token and logs are retained; no recursive deletion is used.

## Offline checks

```sh
node --test bridge/qq/tests/*.test.mjs
```

Tests use simulated native callbacks and temporary installation fixtures. They
do not load QQ, make calls or claim to replace real-account validation.

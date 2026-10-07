# QQ compatibility and verification

The QQ control bridge runs beside NapCat and uses QQ's native AVSDK. OneBot
`record` messages and video attachments are separate from live calls. Control
acknowledgements, native room state and actual bidirectional audio are reported
separately.

## Audited builds

| Platform | Exact build | Native library | Runtime validation |
| --- | --- | --- | --- |
| Linux ARM64 | QQ 3.2.34-53644 | libAVSDKPlugin.so | Incoming private voice: accepted, tone heard remotely, remote speech captured, hangup submitted; group join timed out and remains unverified |
| Linux x64 | QQ 3.2.34-53644 | libAVSDKPlugin.so | Official ELF dispatch, GUI controls, participants and audio ABI checked statically; private/group calls and duplex audio pending live validation |
| Windows x64 | QQ 9.9.36-53644 | AVSDKPlugin.dll | Native dispatch and GUI parameters checked statically; Windows 10 live validation pending |
| macOS ARM64 and x64 | QQ 7.0.2-53644, Universal | libAVSDKPlugin.dylib | Both native slices and GUI parameters checked statically; live validation pending |

The Host matches the exact library SHA256, package version, process platform and
architecture. Unrecognized builds do not gain the recovered control commands by
name or similarity. Linux retains the upstream login/Accept transport as a
separate, explicitly unverified fallback. Windows/macOS require an audited
profile before any Accept command is enabled.

The initially inspected QQ 3.2.30-50969 / NapCat 4.18.13 ARM64 AppImage had no
`resources/app/avsdk`; its application directory was stripped. A complete
Tencent QQ package supplies the architecture-matched library and GUI. Do not transplant only
the newer library into the older installation.

The [official download configuration](https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json)
provided the independent Linux package. Package SHA256:
`181b895cb573548e396e54bb0548cca92ffdc1b1a4b018fa4551bb062385fdca`.
AVSDK SHA256:
`07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c`.

The independent official Linux x64 package is
[`QQ_3.2.34_260924_amd64_01.deb`](https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/9ee04bef/QQ_3.2.34_260924_amd64_01.deb)
(the official website may require its temporary signed download link).
Package SHA256: `436c65e1dd28422e128a21cbddb5fe4e2e6c079d7f27fec2541e014d38cc336e`.
AVSDK SHA256: `c143c4e8ac94c20bcefb037e7062fbeccd0528bd746108d6bf1f0ae8e1710a8b`.
Its Login/StartCall/Accept/Quit/Close, member callbacks, error/timeout and audio
device interfaces were audited independently. The protocol module's 280 GUI
bytecode functions and associated constant pools match ARM64; the separately
checked scene/command enums and StartCall parameters also match. The x64 QQ
package was only extracted and read, and was never executed or installed.

Evidence is retained in [Linux native/GUI reconstruction](../bridge/qq/native-evidence.json),
[Linux x64 reconstruction](../bridge/qq/linux-x64-evidence.json),
[GUI enum evidence](../bridge/qq/gui-enum-evidence.json),
[Windows evidence](../bridge/qq/windows/native-evidence.json) and
[macOS evidence](../bridge/qq/macos/native-evidence.json). QQ binaries are not
redistributed. The Host and initial login/Accept path retain attribution to the
GPL [maibot-qq-voice-call project](https://github.com/ClaudiaGardner/maibot-qq-voice-call).

## Implemented controls

| Capability | Actual native path and boundary |
| --- | --- |
| Observe private invitation | QQ AVSDK listener; observation-only mode never starts a media Host or auto-answers |
| Accept | cmd 5 using the native inviter UID and opaque invitation fields |
| Reject | cmd 9, SceneFriend=1, peer UID, RejectSelfReject=2 |
| Dial private voice | cmd 4, complete GUI JSON; verifies the peer UID ↔ UIN binding with QQ before submission |
| Hang up private call | cmd 10 Close, SceneFriend=1, peer UID, SelfCloseDefault=0 |
| Find active group calls | allowAlbumNotify subscription and native onGroupAudioMemNumChange notifications |
| Join group voice | cmd 4, SceneGroup=3, actual group number, invite_original=3 and zero invitees, matching GUI onJoin |
| Leave group voice | cmd 8 Quit, SceneGroup=3, QuitReasonNone=0 |
| Participants | Verified native UID/account type observations and matching room snapshots; only a complete snapshot marks the roster complete |
| Audio | Independent native Host plus two separate virtual audio routes; no inference of audio success from a connected room |

Native acknowledgement of StartCall, Reject, Close or Quit does not prove
connection or termination. The bridge keeps a submitted/unknown receipt and
awaits actual lifecycle callbacks. A repeated requestId returns its retained
receipt without issuing another command. Uncertain submissions reserve the
call until reconciled. Only one native call is controlled at a time.

The native outputs 20050 (`LogSend`) and 120043 (`AlertMessage`) are diagnostic
strings, not login lifecycle events. They never trigger Login or automatic
relogin. This was confirmed both from native dispatch and real incoming-call
behavior; treating these messages as resets interrupted the initial audio test.

The official GUI initializes the Linux SDK with SetSDKInfo command 57 and
`Login(selfUid, selfUin, "", QQUserDataRoot, "")`. The empty third argument matters:
this native build selects UID login when it is empty; supplying UIN in that slot
selects a different AV identity. The controller uses NapCat's actual data root,
including its isolated test directory. These corrections follow the GUI but the
group path still needs another real test.

Kernel envelopes 55/20000/20001/20002/120003 follow the same verified native
transport. The Host binds messages before inserting the native plugin and keeps
a bounded queue of never-submitted startup envelopes until the authenticated
controller is present. Uncertain deliveries are not automatically replayed.

Native 20005 is `OnConnectTimeOut`; 20003 is `OnError(scene, relationId, message)`.
The Linux decoder exposes a matching room's error field instead of only its
shape. Timeout/error does not prove teardown. The UI retains an active cleanup
operation, and a new call stays blocked until actual termination or an explicit
Host restart. A missing command ACK becomes `unknown` after ten seconds and is
never silently retried.

PPAPI or renderer loss permanently makes that Host unavailable until restart,
even if the embed's JavaScript `postMessage` still exists. A unique Host boot ID
allows the controller to detect a real replacement process, release only the old
local resources and initialize the new process once. Log output and ordinary
status polling do not trigger relogin.

Some QQ builds omit Electron's plugin-exit callbacks. The Host also checks its
own PPAPI child processes (procfs on Linux, Electron metrics where available),
requiring two consecutive missing observations after a process was observed.
An unreadable process list is not treated as a crash. The supervised Linux
`run-av-host.sh` restarts only the isolated media Host after confirmed loss;
NapCat remains logged in. Disabling its restart option, or using an unsupervised
Windows/macOS launcher, still requires manually restarting the media Host.
This releases the old local call; it never redials automatically.

Screen sharing and camera output do not mute or replace the independent PCM
microphone stream. Their source changes release the previous capture resources.
A native AVSDK crash can interrupt all media, so a successful local playback
receipt alone cannot establish that the peer heard the audio.

Participant callback layouts are pinned separately from control support.
Linux, Windows x64 and both macOS slices have independently verified join, leave
and room-snapshot layouts. Native
participant UIDs are not speaking identities and are not guessed QQ numbers.

## Group call boundary

The raw native notification has one object argument with `group_code`,
`onlineCount`, `memberUins`, `seq`, `businessType`, `isNativeTimeout` and raw
`expireTimestamp`. The GUI IPC wrapper is a different shape. The bridge retains
native field types and a local observed time; duplicate or older sequence values
do not refresh freshness.

Join requires a nonempty audio room reported within 60 seconds. Native timed-out,
ended, video and screen-sharing rooms are refused. The GUI maps businessType 0
to ordinary audio and the bridge follows that fallback. It does not infer remote
participants from cached chat messages.

QQ's recovered StartCall API has no atomic `onlyJoinExisting` or expected-room
parameter. A room may end between the latest notification and submission. The
API therefore reports `joinExistingIsAtomic: false`; this limitation cannot be
removed with a fabricated native field.

The inspected `GroupLiveVideoInterfaceWrapper` methods are empty stubs, but
ordinary group voice uses the same verified StartCall path as the GUI. Those
stubs do not disable the implemented ordinary group voice flow.

## Native audio routes

Linux launchers create a private PulseAudio server with `-n`, a user-only socket
directory and only explicit null sinks/remapped microphone. They do not load the
default hardware configuration or alter the desktop server's default devices.
QQ playback is captured from `koishi_rtc_qq_speaker.monitor`; bot audio is played
into `koishi_rtc_qq_mic`; QQ records `koishi_rtc_qq_mic_source`.

An independent Windows/macOS Host does not inherit QQ GUI audio selections.
Both use the verified native device enumeration cmd 103 and selection cmd 102.
The selection command's hard-coded `[1, ""]` response is not evidence that
selection succeeded. Readiness requires a subsequent native device callback
showing both requested routes. Route loss blocks new starts and stops the Host
when required to prevent fallback to physical audio devices. Login and commands
to reject/end calls remain available while audio routes are not ready.

See [Windows setup and virtual device selection](qq-windows.md) and
[macOS setup and BlackHole routes](qq-macos.md). These provide native platform
installation paths, rather than presenting a Linux sidecar as local Windows or
macOS support. Neither platform is claimed live-tested by offline tests.

## Installation and isolation

[Bridge instructions](../bridge/qq/README.md) document install, probe and
uninstall. `prepare-linux-test.py` assembles a new directory using complete QQ
and NapCat distribution files, including imported top-level module chunks. It
never copies NapCat config, account JSON, databases or logs. The native QQ data
path is explicitly redirected in this independent NapCat copy, retaining the
original bundle and both hashes. Electron's `--user-data-dir` alone does not
isolate QQ native account data.

Before a Linux media installation writes files or builds the audio guard, it
checks the QQ executable and AVSDK ELF headers against the current machine.
Only matching Linux x64 or ARM64 files are accepted. The guard is compiled on
that target machine; the ARM64 test machine's generated binary is not portable
to an x64 installation. Observation-only diagnostics do not require a media ABI.

The tested NapCat distribution additionally restricts plugin discovery to a
hard-coded official ID set. Its config does not provide a custom-plugin override.
The independent test preparer adds an explicitly named local bootstrap without
changing that official list. The bootstrap initializes in the actual NapCat
worker, then uses normal plugin manager context/lifecycle and the configured
enable switch. Original loader/bundle bytes and hashes are retained for guarded
restoration. It does not impersonate an official plugin.

The bridge reports the actual UIN from NapCat. The daemon must compare it with
the selected account before controls. A configured account name is not identity
proof. Installers do not start, stop or log into QQ. Switching the same account
requires a coordinated stop/login; running two copies is not an isolation test.

## Live acceptance checks

Offline tests cover parameter construction, account binding, exact platform
profiles, explicit audio route gates, callbacks, call-state transitions,
idempotency, unknown delivery, stale group activity, authenticated HTTP and
reversible installation. They do not execute QQ.

1. Verify actual signed-in UIN, exact library profile and both audio routes.
2. Receive a private call from a consenting test account; verify caller identity,
   explicit acceptance and native room entry.
3. Independently verify remote speech reaches capture and injected audio reaches
   the remote account. Check interruption and absence of audio feedback.
4. Reject an incoming call, hang up an accepted call, and dial the test account;
   compare acknowledgements, native lifecycle and the other account's UI.
5. Start group voice from the other account, wait for a fresh activity event,
   join without inviting users, verify roster changes and leave.
6. Interrupt a bridge operation and verify unknown delivery is not retried.
   Restart reconciliation must observe the changed bootId.
7. Repeat real-call/audio checks on each supported operating system. Static ABI
   equivalence is not a substitute for Linux x64, Windows or macOS runtime tests.

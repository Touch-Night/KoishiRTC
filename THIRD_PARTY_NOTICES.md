# Third-party notices

The QQ AVSDK host and control integration is based in part on
[ClaudiaGardner/maibot-qq-voice-call](https://github.com/ClaudiaGardner/maibot-qq-voice-call),
licensed under GPL-3.0-only. Attribution and retained notices are in
[bridge/qq/ATTRIBUTION.md](bridge/qq/ATTRIBUTION.md). This project is distributed
under GPL-3.0-only; see LICENSE.

QQ, its AVSDK and Tencent client binaries are proprietary and are **not**
redistributed in the npm package. Users install a supported official client.

Runtime packages retain their respective licenses: Koishi and ws (MIT),
discord.js and @discordjs/voice (Apache-2.0), opusscript (MIT; bundled codec
components carry their own licenses). See the installed dependencies' license
files. Koishi console client code is an external dependency, not bundled here.

PulseAudio, PipeWire, PortAudio, Python sounddevice, VB-CABLE and BlackHole are
separately installed system dependencies. Their licenses and installation
requirements are those of their respective authors. Virtual audio drivers and
platform SDK binaries are not bundled in this package.

LiveKit Node RTC and server SDKs and sharp are optional runtime packages under
Apache-2.0. Their native components and transitive dependencies retain the
licenses shipped by their respective maintainers. LiveKit server is only an
optional local integration-test dependency; its executable is not packaged.

Telegram uses separately installed Telethon, PyTgCalls, NTgCalls and Pillow.
Their sources and native wheels are not vendored in this distribution; the
installation tool preserves the upstream packages and their license files.
Telegram account sessions, API credentials and runtime data are excluded from
release artifacts.

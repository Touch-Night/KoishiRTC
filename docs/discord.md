# Discord voice backend

The Discord provider joins ordinary **server voice channels using a bot account**. It receives each speaker as a separate PCM stream and sends PCM directly through Discord's voice transport. It does not need a virtual audio device, a logged-in desktop Discord client, or a physical microphone. Linux, Windows, and macOS use the same Node.js implementation; native DAVE encryption dependency availability still depends on CPU/OS packages.

Bot direct-message calls, group-DM calls, incoming telephone-style calls, Stage channels, and personal-account tokens are not supported. This backend is independent of QQ desktop calling and cannot supply QQ signaling.

## Setup

1. Use Node.js 22.19 or newer, as required by this plugin. Install the plugin with optional dependencies enabled. The implementation uses `discord.js` 14, `@discordjs/voice` 0.19.2 or newer compatible 0.19 releases, and `opusscript`. The voice SDK includes DAVE encryption support. Do not disable DAVE to work around an installation error; inspect the dependency report instead.
2. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications). Keep its Bot Token secret. Copy the **bot user ID**, server ID, and voice channel ID using Discord's developer mode.
3. Invite the bot to the intended server. Its effective permissions on the selected voice channel must include **View Channel, Connect, and Speak**. Administrator permissions are unnecessary. The provider requests only the Guilds and GuildVoiceStates gateway intents; it does not request message content or the privileged GuildMembers intent.
4. Add one Discord configuration entry in the Koishi plugin settings:

   ```yaml
   discord:
     - id: discord-voice
       token: "BOT_TOKEN"
       selfId: "BOT_USER_ID"
       guildIds:
         - "ALLOWED_SERVER_ID"
   ```

   The default `guildIds: []` permits no server. Joining requires an explicit allowed `guildId` and a voice-channel `targetId`. The channel's actual server is checked again after lookup. The bot identity is checked after login; a token for a different bot or a non-bot account is rejected before any voice capability becomes available.
5. In the RTC console, choose this provider and a listed voice channel, then explicitly join. Listing channels performs metadata requests only. Starting the plugin logs in the configured bot but does not automatically join a channel. The provider refuses to take over a bot already connected to a voice channel by another owner.

Missing optional dependencies leave the Discord provider unavailable; they do not prevent use of the desktop bridge. Install dependencies in the Koishi deployment's package environment, not an unrelated system directory. The diagnostic report includes SDK codec/encryption dependency information without the token. No real Discord connection is used by the automated tests.

## Audio and control

The provider implements `CallProvider`. `dial({ kind: 'group', guildId, targetId })` joins a server voice channel and resolves only after the voice SDK reports Ready. `hangup()` leaves and releases streams and codec instances. `channels()` lists ordinary, permitted channels in the configured servers. There is one active call per provider.

PCM is **48,000 Hz, two channels, interleaved signed 16-bit little-endian** (`pcm_s16le`). Incoming frames normally contain 20 ms / 3,840 bytes. Outgoing writes may contain any aligned number of stereo samples up to one second, subject to queue capacity. The provider combines adjacent writes into 20 ms Opus frames; a final partial frame is padded with silence without counting that padding as submitted bytes. Producers should normally supply complete 20 ms frames. There is no implicit resampling.

Receive events include `speakerId` from the SDK's Discord SSRC-to-user mapping. Concurrent speakers remain separate; they are not mixed and then guessed. Each user's sequence advances independently across speech bursts, and timestamps mark local frame delivery, not the remote microphone's original clock. Consumers doing transcription should preserve that per-user separation; consumers needing one playback bus must explicitly mix or choose streams. At most 64 speakers are decoded simultaneously. Audio is held in memory only and is not recorded to files.

`setMuted(true)` cancels queued output and rejects new writes. It suppresses this provider's outgoing audio locally; it does not server-mute the bot or disable incoming audio. `clearAudio()` cancels the unsent suffix. Already dispatched network packets cannot be recalled. The unsent queue is bounded to 2 seconds and 256 pending writes by default; programmatic construction accepts `maxQueueMs` from 20 to 10,000. Queue-full rejection is explicit. Consumers should wait for progress or cancel deliberately, rather than replaying an entire partially dispatched utterance.

When voice or gateway connectivity is lost, the current call fails, remaining output fails, and audio resources are released. A guarded gateway adapter prevents SDK voice rejoin requests after teardown starts. Gateway reconnection may restore provider availability, but it does not automatically restore the old voice call. Join again explicitly. Moving the bot to another channel or server-muting/deafening it also ends the session.

## Receipt evidence

Discord has no receipt proving a participant's speaker played a sample. Accordingly:

| Field or state | Meaning |
| --- | --- |
| `acceptedBytes`, `state: 'queued'` | PCM accepted into the bounded local queue; nothing has necessarily been sent. |
| `dispatchedBytes`, `evidence: 'discord-udp-dispatch'` | That PCM prefix was encoded and the voice SDK returned success handing its packet to the local UDP transport. This does not confirm network delivery or remote playback. |
| `state: 'playing'` | Dispatch is in progress; inspect `dispatchedBytes`. |
| `state: 'dispatched'` | All submitted bytes reached that local UDP-dispatch boundary. |
| `playedBytes` | Always zero for this provider; remote playback is unknown. |
| `state: 'cancelled'` / `'failed'` | Unsent output was stopped; `dispatchedBytes` preserves the already dispatched prefix. |

The distinction from desktop device-drain/device-clock evidence is intentional. Consumers must not wait only for `state: 'played'` when using Discord, or label `dispatched` as “the other person heard it.”

## Validation and limits

Run `npx tsx --test test/discord-provider.test.ts` for isolated fake-transport tests and a real local Opus encode/decode round trip. These cover allowlists, identity mismatch, channel permissions, direct/Stage rejection, simultaneous speaker identity, queue limits, mute/clear, dispatch evidence, cancellation, and disconnect cleanup. They neither log in a bot nor join a real channel.

Live Discord acceptance is currently deferred. A later deliberate acceptance run should verify voice connection and DAVE negotiation, two-way intelligible audio, two simultaneous speaker IDs, output interruption, permission failure, and disconnect cleanup. Passing offline tests alone does not establish live receive compatibility. The SDK explicitly notes that [audio receiving is not documented by Discord and stable support is not guaranteed](https://discord.js.org/docs/packages/voice/0.19.2). See the official [voice connection protocol](https://docs.discord.com/developers/topics/voice-connections) and [SDK source](https://github.com/discordjs/discord.js/tree/main/packages/voice) for transport behavior.

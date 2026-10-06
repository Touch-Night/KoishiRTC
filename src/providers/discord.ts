import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { RtcError, validateAudio } from '../core.js';
import { terminalStates, unavailableCapabilities } from '../types.js';
import type { Account, AudioFrame, CallProvider, CallRequest, CallSnapshot, Diagnostic, Participant, PlaybackReceipt, ProviderEvent } from '../types.js';

export interface DiscordConfig { id: string; token: string; selfId: string; guildIds?: string[]; maxQueueMs?: number }
interface Member { id: string; displayName?: string; voice?: { channelId?: string | null } }
interface Channel {
  id: string; name: string; type: number; guildId: string; members: Map<string, Member>;
  permissionsFor(id: string): { has(permission: string): boolean } | null;
}
interface Guild {
  id: string; name: string; voiceAdapterCreator: unknown;
  members: { me: Member | null };
  channels: { fetch(id: string): Promise<Channel | null>; fetch(): Promise<Map<string, Channel | null>> };
}
interface VoiceState { id: string; guild: { id: string }; channelId: string | null; member?: Member | null; serverMute?: boolean; serverDeaf?: boolean }
interface Client extends EventEmitter {
  user: { id: string; bot?: boolean } | null; guilds: { cache: Map<string, Guild> };
  login(token: string): Promise<unknown>; destroy(): Promise<void>; isReady(): boolean;
}
interface Codec { encode(pcm: Buffer, samples: number): Buffer; decode(opus: Buffer): Buffer; delete(): void }
interface Voice extends EventEmitter {
  state: { status: string }; receiver: { speaking: EventEmitter; subscribe(id: string, options: object): Readable };
  playOpusPacket(packet: Buffer): boolean | undefined; setSpeaking(speaking: boolean): unknown; destroy(): void;
}
interface Adapter { sendPayload(payload: { d?: { channel_id?: string | null } }): boolean; destroy(): void }
/** Injectable transport boundary for offline tests; production always loads the official SDK. */
export interface DiscordRuntime {
  client: Client;
  join(options: { channelId: string; guildId: string; adapterCreator: unknown; group: string; selfDeaf: false; selfMute: false }): Voice;
  ready(connection: Voice, signal: AbortSignal): Promise<unknown>;
  codec(): Codec;
  receiveOptions: object;
  dependencyReport?: string;
}
export interface DiscordDependencies {
  load?: () => Promise<DiscordRuntime>;
  every?: (callback: () => void, ms: number) => () => void;
}
async function loadRuntime(): Promise<DiscordRuntime> {
  const [discord, voice, opus] = await Promise.all([import('discord.js'), import('@discordjs/voice'), import('opusscript')]);
  const client = new discord.Client({ intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildVoiceStates] });
  const Opus = opus.default;
  return {
    client: client as unknown as Client,
    join: options => voice.joinVoiceChannel(options as Parameters<typeof voice.joinVoiceChannel>[0]) as unknown as Voice,
    ready: (connection, signal) => voice.entersState(connection as unknown as import('@discordjs/voice').VoiceConnection, voice.VoiceConnectionStatus.Ready, signal),
    codec: () => new Opus(48000, 2, Opus.Application.AUDIO),
    receiveOptions: { end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 120 }, highWaterMark: 16 },
    dependencyReport: voice.generateDependencyReport(),
  };
}
const FRAME_BYTES = 960 * 2 * 2;
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);
const clone = <T>(value: T): T => structuredClone(value);
interface Pending { data: Buffer; offset: number; receipt: PlaybackReceipt }
interface Receive { stream: Readable; decoder: Codec; partial: Buffer }
interface Active {
  snapshot: CallSnapshot; guild: Guild; channel: Channel; voice: Voice; encoder: Codec;
  queue: Pending[]; queuedBytes: number; recentIds: Set<string>; receivers: Map<string, Receive>; sequences: Map<string, number>;
  stopClock?: () => void; silence: number; connected: boolean; closing: boolean; abort: AbortController;
  onSpeaking: (id: string) => void; onSilence: (id: string) => void;
}

/** Discord bot guild voice channels. Direct calls and Stage channels are deliberately unsupported. */
export class DiscordProvider implements CallProvider {
  readonly id: string;
  readonly account: Account;
  readonly events = new EventEmitter();
  readonly audioFormat = { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le' } as const;
  private runtime?: DiscordRuntime;
  private active?: Active;
  private snapshots = new Map<string, CallSnapshot>();
  private allowed: Set<string>;
  private maxQueueBytes: number;
  private stopped = true;
  private available = false;
  private identityVerified = false;
  private starting?: Promise<void>;
  private lifecycle = new AbortController();
  private dialing = false;
  private lastError?: string;
  private handlers: Array<[string, (...args: any[]) => void]> = [];

  constructor(private config: DiscordConfig, private dependencies: DiscordDependencies = {}) {
    if (!/^[\w.-]{1,80}$/.test(config.id) || !config.token?.trim() || !/^\d{1,22}$/.test(config.selfId)) throw new RtcError('INVALID_CONFIG', 'Discord 需要有效的后端名称、Bot Token 和机器人用户 ID');
    if (config.guildIds?.some(id => !/^\d{1,22}$/.test(id))) throw new RtcError('INVALID_CONFIG', 'Discord 服务器白名单必须是服务器 ID');
    const maxQueueMs = config.maxQueueMs ?? 2000;
    if (!Number.isFinite(maxQueueMs) || maxQueueMs < 20 || maxQueueMs > 10000) throw new RtcError('INVALID_CONFIG', 'Discord 音频队列上限必须为 20–10000 毫秒');
    this.id = config.id; this.account = { platform: 'discord', selfId: config.selfId };
    this.allowed = new Set(config.guildIds ?? []); this.maxQueueBytes = Math.floor(maxQueueMs * 192);
  }
  private emit(event: ProviderEvent) { this.events.emit('event', event); }
  private safeError(error: unknown) { return String(error instanceof Error ? error.message : error).replaceAll(this.config.token, '[redacted]').slice(0, 500); }
  private notice(error: unknown) { this.lastError = this.safeError(error); this.emit({ type: 'error', error: this.lastError }); }
  capabilities() {
    const caps = unavailableCapabilities('Discord Bot 不支持私聊语音电话、接听来电或 Stage 频道');
    if (this.available && this.allowed.size) for (const key of ['hangup', 'joinGroup', 'leaveGroup', 'receiveAudio', 'sendAudio', 'participants', 'speakerIdentity', 'mute'] as const) caps[key] = { supported: true };
    else for (const key of Object.keys(caps) as (keyof typeof caps)[]) caps[key] = { supported: false, reason: this.available ? '请先配置允许加入的服务器 ID' : 'Discord Bot 未完成登录和身份校验' };
    return caps;
  }
  calls() { return [...this.snapshots.values()].map(clone); }
  private publish(active: Active) {
    active.snapshot.updatedAt = Date.now(); this.snapshots.set(active.snapshot.id, clone(active.snapshot));
    this.emit({ type: 'call', call: clone(active.snapshot) });
    const ended = [...this.snapshots.values()].filter(c => terminalStates.has(c.state));
    for (const old of ended.slice(0, -100)) this.snapshots.delete(old.id);
  }
  async start() {
    if (this.starting) return this.starting;
    if (!this.stopped) return;
    this.stopped = false; this.lifecycle = new AbortController(); const lifecycle = this.lifecycle;
    this.starting = this.connect(lifecycle).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async connect(lifecycle: AbortController) {
    let runtime: DiscordRuntime | undefined;
    try {
      runtime = await (this.dependencies.load ?? loadRuntime)();
      lifecycle.signal.throwIfAborted(); this.runtime = runtime;
      const client = runtime.client;
      const listen = (name: string, handler: (...args: any[]) => void) => { this.handlers.push([name, handler]); client.on(name, handler); };
      listen('error', error => this.notice(error));
      listen('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => this.voiceState(oldState, newState));
      listen('shardDisconnect', () => {
        this.available = false;
        if (this.active) this.finish(this.active, 'failed', 'Discord Gateway 已断开；请手动重新加入频道');
        this.emit({ type: 'availability' });
      });
      const restore = () => { if (!this.stopped && this.identityVerified && client.isReady() && client.user?.id === this.account.selfId) { this.available = true; this.emit({ type: 'availability' }); } };
      listen('shardResume', restore); listen('shardReady', restore); listen('clientReady', restore);
      listen('invalidated', () => { this.notice('Discord 登录会话失效'); void this.stop(); });
      const loginSignal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(20000)]);
      await bounded(client.login(this.config.token), loginSignal);
      if (!client.isReady()) await once(client, 'clientReady', { signal: loginSignal });
      lifecycle.signal.throwIfAborted();
      if (!client.isReady() || client.user?.id !== this.account.selfId || client.user.bot !== true) throw new RtcError('IDENTITY_MISMATCH', 'Discord 实际登录的 Bot ID 与配置不一致');
      // Construct and release a codec before exposing audio capabilities.
      const probe = runtime.codec(); probe.delete();
      this.identityVerified = true; this.available = true; this.lastError = undefined; this.emit({ type: 'availability' });
    } catch (error) {
      this.available = false; this.identityVerified = false; this.stopped = true;
      if (runtime) { for (const [event, handler] of this.handlers) runtime.client.off(event, handler); this.handlers = []; await runtime.client.destroy().catch(() => {}); }
      this.runtime = undefined; this.notice(error); throw new RtcError('DISCORD_START_FAILED', this.safeError(error));
    }
  }
  async stop() {
    this.stopped = true; this.available = false; this.identityVerified = false; this.lifecycle.abort(new RtcError('DISPOSED', 'Discord 后端已停止'));
    if (this.active) this.finish(this.active, 'ended');
    const runtime = this.runtime; this.runtime = undefined;
    if (runtime) { for (const [event, handler] of this.handlers) runtime.client.off(event, handler); this.handlers = []; await runtime.client.destroy(); }
    this.emit({ type: 'availability' });
  }
  private online() {
    if (!this.available || !this.runtime?.client.isReady()) throw new RtcError('DISCORD_OFFLINE', 'Discord Bot 尚未连接');
    return this.runtime;
  }
  private permission(channel: Channel) {
    const permissions = channel.permissionsFor(this.account.selfId);
    return !!permissions && ['ViewChannel', 'Connect', 'Speak'].every(permission => permissions.has(permission));
  }
  async channels() {
    const { client } = this.online(); const result: Array<{ id: string; name: string; guildId: string; guildName: string }> = [];
    for (const guildId of this.allowed) {
      const guild = client.guilds.cache.get(guildId); if (!guild) continue;
      const channels = await guild.channels.fetch();
      for (const channel of channels.values()) if (channel?.type === 2 && this.permission(channel)) result.push({ id: channel.id, name: channel.name, guildId, guildName: guild.name });
    }
    return result;
  }
  async dial(request: CallRequest, signal?: AbortSignal) {
    signal?.throwIfAborted(); const runtime = this.online();
    if (request.kind !== 'group') throw new RtcError('UNSUPPORTED', 'Discord Bot 仅支持加入服务器语音频道');
    if (!request.guildId || !this.allowed.has(request.guildId)) throw new RtcError('GUILD_NOT_ALLOWED', '该服务器不在 Discord 通话白名单中');
    if (this.active || this.dialing) throw new RtcError('ACCOUNT_BUSY', 'Discord Bot 已有正在进行的通话');
    const guild = runtime.client.guilds.cache.get(request.guildId);
    if (!guild) throw new RtcError('GUILD_UNAVAILABLE', '机器人尚未加入此服务器');
    if (guild.members.me?.voice?.channelId) throw new RtcError('ACCOUNT_BUSY', '机器人已在语音频道中，请先退出，避免接管其他通话');
    this.dialing = true; let active: Active | undefined;
    const abort = AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
    try {
      const channel = await bounded(guild.channels.fetch(request.targetId), abort);
      abort.throwIfAborted(); this.online();
      if (!channel || channel.guildId !== guild.id || channel.type !== 2) throw new RtcError('INVALID_CHANNEL', '请选择该服务器内的普通语音频道；不支持 Stage 频道');
      if (!this.permission(channel)) throw new RtcError('MISSING_PERMISSION', '机器人缺少查看频道、连接或说话权限');
      const encoder = runtime.codec();
      let voice: Voice;
      // The SDK can attempt a rejoin immediately after emitting a state change.
      // Block that payload synchronously, then destroy after its callback unwinds.
      const adapterCreator = (methods: unknown) => {
        const adapter = (guild.voiceAdapterCreator as (methods: unknown) => Adapter)(methods);
        return { ...adapter, sendPayload: (payload: Parameters<Adapter['sendPayload']>[0]) => active?.closing && payload.d?.channel_id ? false : adapter.sendPayload(payload) };
      };
      try { voice = runtime.join({ channelId: channel.id, guildId: guild.id, adapterCreator, group: `rtc:${this.id}`, selfDeaf: false, selfMute: false }); }
      catch (error) { encoder.delete(); throw error; }
      const now = Date.now();
      active = { snapshot: { id: `${this.id}:${randomUUID()}`, providerId: this.id, account: this.account, kind: 'group', targetId: channel.id, direction: 'outgoing', state: 'connecting', createdAt: now, updatedAt: now, participants: [], muted: false },
        guild, channel, voice, encoder, queue: [], queuedBytes: 0, recentIds: new Set(), receivers: new Map(), sequences: new Map(), silence: 0, connected: false, closing: false, abort: new AbortController(), onSpeaking: () => {}, onSilence: () => {} };
      this.active = active; const call = active;
      voice.on('error', error => this.finish(call, 'failed', this.safeError(error), true));
      voice.on('stateChange', (_old, state) => {
        if (call.closing) return;
        if (state.status === 'destroyed' || state.status === 'disconnected' || call.connected && state.status !== 'ready') this.finish(call, 'failed', 'Discord 语音连接已中断；请手动重新加入', true);
      });
      call.onSpeaking = id => this.receive(call, id);
      call.onSilence = id => this.speaking(call, id, false);
      voice.receiver.speaking.on('start', call.onSpeaking); voice.receiver.speaking.on('end', call.onSilence);
      call.snapshot.participants = [...channel.members.values()].map(member => ({ id: member.id, name: member.displayName, identity: 'platform' }));
      this.publish(call);
      await runtime.ready(voice, AbortSignal.any([abort, call.abort.signal]));
      abort.throwIfAborted(); if (call.closing || this.active !== call) throw new RtcError('CALL_ENDED', 'Discord 通话已结束');
      call.connected = true; call.snapshot.state = 'connected'; this.publish(call);
      call.stopClock = (this.dependencies.every ?? ((callback, ms) => { const timer = setInterval(callback, ms); timer.unref(); return () => clearInterval(timer); }))(() => this.tick(call), 20);
      return clone(call.snapshot);
    } catch (error) {
      if (active) this.finish(active, 'failed', this.safeError(error));
      throw new RtcError('DISCORD_JOIN_FAILED', this.safeError(error));
    } finally { this.dialing = false; }
  }
  async accept(_id: string) { throw new RtcError('UNSUPPORTED', 'Discord Bot 不支持接听私聊电话'); }
  async reject(_id: string) { throw new RtcError('UNSUPPORTED', 'Discord Bot 不支持拒接私聊电话'); }
  private current(id: string) {
    if (!this.active || this.active.snapshot.id !== id || this.active.closing) throw new RtcError('CALL_NOT_FOUND', 'Discord 通话已结束或不存在');
    return this.active;
  }
  async hangup(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.finish(this.current(id), 'ended'); }
  async setMuted(id: string, muted: boolean) {
    const active = this.current(id); if (muted) this.cancel(active, 'cancelled');
    active.snapshot.muted = muted; this.publish(active);
  }
  async clearAudio(id: string) { this.cancel(this.current(id), 'cancelled'); }
  async writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt> {
    const active = this.current(frame.callId); validateAudio(frame);
    if (frame.sampleRate !== 48000 || frame.channels !== 2) throw new RtcError('INVALID_AUDIO', 'Discord 需要 48 kHz 双声道 PCM S16LE');
    if (!active.connected) throw new RtcError('NOT_CONNECTED', 'Discord 语音尚未连接');
    if (active.snapshot.muted) throw new RtcError('MUTED', 'Discord 音频发送已静音');
    if (!playbackId || playbackId.length > 160 || active.recentIds.has(playbackId) || active.queue.some(entry => entry.receipt.id === playbackId)) throw new RtcError('INVALID_PLAYBACK_ID', '播放 ID 无效或已使用');
    if (active.queuedBytes + frame.data.byteLength > this.maxQueueBytes || active.queue.length >= 256) throw new RtcError('BACKPRESSURE', 'Discord 音频队列已满');
    const receipt: PlaybackReceipt = { id: playbackId, callId: frame.callId, acceptedBytes: frame.data.byteLength, playedBytes: 0, dispatchedBytes: 0, state: 'queued', evidence: 'discord-udp-dispatch' };
    active.queue.push({ data: Buffer.from(frame.data), offset: 0, receipt }); active.queuedBytes += frame.data.byteLength;
    this.emit({ type: 'playback', playback: clone(receipt) }); return clone(receipt);
  }
  private receipt(active: Active, entry: Pending, state: PlaybackReceipt['state'], error?: string) {
    entry.receipt.state = state; entry.receipt.error = error;
    if (['dispatched', 'failed', 'cancelled'].includes(state)) {
      active.recentIds.add(entry.receipt.id); if (active.recentIds.size > 256) active.recentIds.delete(active.recentIds.values().next().value!);
    }
    this.emit({ type: 'playback', playback: clone(entry.receipt) });
  }
  private tick(active: Active) {
    if (this.active !== active || !active.connected || active.closing) return;
    try {
      if (!active.queue.length || active.snapshot.muted) {
        if (active.silence > 0) { if (active.voice.playOpusPacket(SILENCE) !== true) throw new Error('Discord 拒绝发送语音结束包'); if (--active.silence === 0) active.voice.setSpeaking(false); }
        return;
      }
      const pcm = Buffer.alloc(FRAME_BYTES); let copied = 0;
      const portions: Array<{ entry: Pending; bytes: number }> = [];
      for (const entry of active.queue) {
        const bytes = Math.min(FRAME_BYTES - copied, entry.data.length - entry.offset);
        entry.data.copy(pcm, copied, entry.offset, entry.offset + bytes); portions.push({ entry, bytes }); copied += bytes;
        if (copied === FRAME_BYTES) break;
      }
      const packet = active.encoder.encode(pcm, 960);
      if (active.voice.playOpusPacket(packet) !== true) throw new Error('Discord UDP 音频发送未被接受');
      active.silence = 5;
      for (const { entry, bytes } of portions) {
        entry.offset += bytes; active.queuedBytes -= bytes; entry.receipt.dispatchedBytes = entry.offset;
        if (entry.offset === entry.data.length) { active.queue.shift(); this.receipt(active, entry, 'dispatched'); }
        else this.receipt(active, entry, 'playing');
      }
    } catch (error) { this.finish(active, 'failed', this.safeError(error)); }
  }
  private cancel(active: Active, state: 'cancelled' | 'failed', error?: string) {
    const entries = active.queue.splice(0); active.queuedBytes = 0;
    for (const entry of entries) this.receipt(active, entry, state, error);
  }
  private speaking(active: Active, id: string, speaking: boolean) {
    if (active.closing || id === this.account.selfId) return;
    let participant = active.snapshot.participants.find(member => member.id === id);
    if (!participant) { participant = { id, identity: 'platform' }; active.snapshot.participants.push(participant); }
    if (participant.speaking !== speaking) { participant.speaking = speaking; this.publish(active); }
  }
  private receive(active: Active, id: string) {
    if (active.closing || id === this.account.selfId || !/^\d{1,22}$/.test(id)) return;
    this.speaking(active, id, true); if (active.receivers.has(id)) return;
    if (active.receivers.size >= 64) { this.notice('同时接收者超过 64 人，暂不接收更多音轨'); return; }
    try {
      const runtime = this.runtime!; const decoder = runtime.codec();
      let stream: Readable;
      try { stream = active.voice.receiver.subscribe(id, runtime.receiveOptions); } catch (error) { decoder.delete(); throw error; }
      const receiver: Receive = { stream, decoder, partial: Buffer.alloc(0) }; active.receivers.set(id, receiver);
      const close = () => { if (active.receivers.get(id) !== receiver) return; active.receivers.delete(id); decoder.delete(); };
      stream.on('data', (packet: Buffer) => {
        if (active.closing || !active.connected || this.active !== active) return;
        try {
          const pcm = decoder.decode(packet);
          if (!pcm.length || pcm.length % 4 || pcm.length > 23040) throw new Error('Discord 返回无效的解码音频长度');
          receiver.partial = Buffer.concat([receiver.partial, pcm]);
          while (receiver.partial.length >= FRAME_BYTES) {
            const data = Buffer.from(receiver.partial.subarray(0, FRAME_BYTES)); receiver.partial = receiver.partial.subarray(FRAME_BYTES);
            const sequence = (active.sequences.get(id) ?? -1) + 1; active.sequences.set(id, sequence);
            this.emit({ type: 'audio', audio: { callId: active.snapshot.id, speakerId: id, encoding: 'pcm_s16le', sampleRate: 48000, channels: 2, sequence, timestamp: Date.now(), data } });
          }
        } catch (error) { stream.destroy(); this.notice(`Discord 用户 ${id} 音轨解码失败：${this.safeError(error)}`); }
      });
      stream.once('error', error => { this.notice(`Discord 用户 ${id} 音轨接收失败：${this.safeError(error)}`); close(); });
      stream.once('end', close); stream.once('close', close);
    } catch (error) { this.notice(error); }
  }
  private voiceState(oldState: VoiceState, state: VoiceState) {
    const active = this.active; if (!active || state.guild.id !== active.guild.id || active.closing) return;
    if (state.id === this.account.selfId) {
      if (active.connected && state.channelId !== active.channel.id) this.finish(active, 'failed', 'Discord Bot 已被移出或移动到其他语音频道');
      else if (state.serverMute || state.serverDeaf) this.finish(active, 'failed', 'Discord Bot 被服务器静音或禁听，无法保持双向音频');
      return;
    }
    if (state.channelId === active.channel.id) {
      const participant: Participant = { id: state.id, name: state.member?.displayName, identity: 'platform' };
      if (!active.snapshot.participants.some(p => p.id === state.id)) { active.snapshot.participants.push(participant); this.publish(active); }
    } else if (oldState.channelId === active.channel.id) {
      active.receivers.get(state.id)?.stream.destroy(); active.snapshot.participants = active.snapshot.participants.filter(p => p.id !== state.id); this.publish(active);
    }
  }
  private finish(active: Active, state: 'ended' | 'failed', error?: string, deferDestroy = false) {
    if (active.closing) return;
    active.closing = true; active.abort.abort(new Error(error ?? 'Discord 通话已结束')); active.stopClock?.();
    this.cancel(active, state === 'failed' ? 'failed' : 'cancelled', error);
    active.voice.receiver.speaking.off('start', active.onSpeaking); active.voice.receiver.speaking.off('end', active.onSilence);
    for (const [id, receiver] of active.receivers) { active.receivers.delete(id); receiver.stream.destroy(); receiver.decoder.delete(); }
    active.encoder.delete();
    const destroy = () => { try { if (active.voice.state.status !== 'destroyed') active.voice.destroy(); } catch (failure) { this.notice(failure); } };
    if (deferDestroy) queueMicrotask(destroy); else destroy();
    active.snapshot.state = state; active.snapshot.error = error;
    for (const participant of active.snapshot.participants) participant.speaking = false;
    if (this.active === active) this.active = undefined; this.publish(active);
    if (error) this.notice(error);
  }
  async diagnostics(): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [
      { id: 'identity', level: this.available ? 'ok' : 'error', message: this.available ? `Discord Bot 身份已校验：${this.account.selfId}` : 'Discord Bot 未登录或身份校验未完成' },
      { id: 'guild-allowlist', level: this.allowed.size ? 'ok' : 'warning', message: `允许加入 ${this.allowed.size} 个服务器；白名单外一律拒绝` },
      { id: 'playback-evidence', level: 'warning', message: 'Discord 只能确认音频交给本地 UDP 传输，无法确认远端已播放；playedBytes 始终为 0' },
      { id: 'receive-support', level: 'warning', message: 'Discord 音频接收依赖未公开稳定保证的协议，升级 Discord 或 SDK 后需要再次验收' },
    ];
    if (this.lastError) diagnostics.push({ id: 'last-error', level: 'error', message: this.lastError });
    if (this.runtime?.dependencyReport) diagnostics.push({ id: 'dependencies', level: 'ok', message: 'Discord 音频依赖报告', detail: this.runtime.dependencyReport });
    return diagnostics;
  }
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

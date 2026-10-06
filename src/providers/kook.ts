import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { isIP } from 'node:net';
import { RtcError, validateAudio } from '../core.js';
import { terminalStates, unavailableCapabilities } from '../types.js';
import type { AudioFrame, CallProvider, CallRequest, CallSnapshot, Diagnostic, PlaybackReceipt, ProviderEvent } from '../types.js';

export interface KookConfig { id: string; token: string; selfId: string; channelIds: string[]; maxQueueMs?: number; channelPasswords?: Record<string, string> }
interface Codec { encode(pcm: Buffer, samples: number): Buffer; encoderCTL(request: number, value: number): void; delete(): void }
export interface KookDependencies {
  fetch?: typeof fetch;
  codec?: () => Promise<Codec>;
  socket?: (family: 'udp4' | 'udp6') => Socket;
  every?: (fn: () => void, milliseconds: number) => () => void;
}
interface Entry { data: Buffer; offset: number; receipt: PlaybackReceipt }
interface Active {
  snapshot: CallSnapshot; socket?: Socket; codec?: Codec; queue: Entry[]; queuedBytes: number; seen: Set<string>;
  sequence: number; timestamp: number; ssrc: number; pt: number; sentPackets: number; sentOctets: number;
  lastSr: number; port: number; rtcpPort: number; ip: string; closed: boolean; ticking: boolean; generation: number;
  cancelTick?: () => void; cancelKeepalive?: () => void; keeping: boolean; abort: AbortController;
  initDone: Promise<void>; finishInit: () => void; attemptedJoin: boolean; closeTask?: Promise<void>;
}
const PCM_BYTES = 3840;
const clone = <T>(x: T): T => structuredClone(x);
function every(fn: () => void, ms: number) { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); }
/** KOOK's documented Bot interface is RTP Opus upload only, not an audio receiver. */
export class KookProvider implements CallProvider {
  readonly events = new EventEmitter();
  readonly id: string;
  readonly account: { platform: string; selfId: string };
  readonly audioFormat = { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le' } as const;
  private available = false;
  private lifecycle = new AbortController();
  private active?: Active;
  private joining?: Promise<CallSnapshot>;
  private stopping?: Promise<void>;
  private history = new Map<string, CallSnapshot>();
  private readonly allowed: Set<string>;
  private readonly maxQueue: number;
  private lastError?: string;
  constructor(private config: KookConfig, private deps: KookDependencies = {}) {
    if (!/^[\w.-]{1,80}$/.test(config.id) || !config.token?.trim() || !/^\d{1,32}$/.test(config.selfId) || !Array.isArray(config.channelIds) || config.channelIds.some(x => !/^\d{1,32}$/.test(x))) throw new RtcError('INVALID_CONFIG', 'KOOK 需要后端名称、Bot Token、账号 ID 和频道 ID 白名单');
    const queue = config.maxQueueMs ?? 2000;
    if (!Number.isFinite(queue) || queue < 20 || queue > 10000) throw new RtcError('INVALID_CONFIG', '音频队列须为 20–10000 毫秒');
    this.id = config.id; this.account = { platform: 'kook', selfId: config.selfId }; this.allowed = new Set(config.channelIds); this.maxQueue = Math.floor(queue * 192);
  }
  private emit(e: ProviderEvent) { this.events.emit('event', e); }
  private safe(e: unknown) { return String(e instanceof Error ? e.message : e).replaceAll(this.config.token, '[redacted]').slice(0, 500); }
  private error(e: unknown) { this.lastError = this.safe(e); this.emit({ type: 'error', error: this.lastError }); }
  private async api(path: string, body?: object, signal?: AbortSignal): Promise<any> {
    const response = await (this.deps.fetch ?? fetch)(`https://www.kookapp.cn/api/v3/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bot ${this.config.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new RtcError('KOOK_HTTP', `KOOK HTTP ${response.status}`);
    const result = await response.json() as any;
    if (result?.code !== 0) throw new RtcError('KOOK_API', `KOOK ${Number(result?.code)}: ${this.safe(result?.message ?? '请求失败')}`);
    return result.data;
  }
  private async codec() {
    if (this.deps.codec) return this.deps.codec();
    const { default: Opus } = await import('opusscript'); return new Opus(48000, 2, Opus.Application.AUDIO);
  }
  capabilities() {
    const caps = unavailableCapabilities('KOOK 官方语音 API 仅提供频道音频推流，不提供私聊电话、收音或视频');
    for (const key of ['joinGroup', 'leaveGroup', 'hangup', 'sendAudio', 'mute'] as const) caps[key] = this.available && this.allowed.size ? { supported: true } : { supported: false, reason: 'KOOK 未登录或未配置允许加入的频道' };
    return caps;
  }
  calls() { return [...this.history.values()].map(clone); }
  private publish(a: Active) {
    a.snapshot.updatedAt = Date.now(); this.history.set(a.snapshot.id, clone(a.snapshot)); this.emit({ type: 'call', call: clone(a.snapshot) });
    for (const old of [...this.history.values()].filter(c => terminalStates.has(c.state)).slice(0, -100)) this.history.delete(old.id);
  }
  async start() {
    if (this.available) return;
    this.lifecycle = new AbortController(); const signal = this.lifecycle.signal;
    try {
      const me = await this.api('user/me', undefined, signal); signal.throwIfAborted();
      if (String(me?.id) !== this.account.selfId || me.bot !== true) throw new RtcError('IDENTITY_MISMATCH', 'KOOK 登录账号与配置不一致，或不是机器人账号');
      const codec = await this.codec(); codec.delete(); signal.throwIfAborted(); this.available = true; this.lastError = undefined; this.emit({ type: 'availability' });
    } catch (e) { this.available = false; this.error(e); throw new RtcError('KOOK_START_FAILED', this.safe(e)); }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.available = false; this.lifecycle.abort(new RtcError('DISPOSED', 'KOOK 后端已停止'));
      await this.joining?.catch(() => {});
      if (this.active) await this.close(this.active, 'ended').catch(e => this.error(e));
      this.emit({ type: 'availability' });
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private online() { if (!this.available) throw new RtcError('KOOK_OFFLINE', 'KOOK 尚未通过身份验证'); }
  async channels() {
    this.online(); const result: Array<{ id: string; name: string; guildId: string }> = [];
    for (const id of this.allowed) {
      const channel = await this.api(`channel/view?target_id=${encodeURIComponent(id)}`, undefined, this.lifecycle.signal);
      if (channel?.type === 2 && String(channel.id) === id) result.push({ id, name: String(channel.name), guildId: String(channel.guild_id) });
    }
    return result;
  }
  async dial(request: CallRequest, signal?: AbortSignal) {
    this.online(); signal?.throwIfAborted();
    if (request.kind !== 'group' || request.groupMode === 'create' || (request.media && request.media !== 'audio')) throw new RtcError('UNSUPPORTED', 'KOOK 仅支持加入现有语音频道推流');
    if (!this.allowed.has(request.targetId)) throw new RtcError('CHANNEL_NOT_ALLOWED', 'KOOK 频道不在白名单');
    if (this.active || this.joining) throw new RtcError('ACCOUNT_BUSY', 'KOOK 已有正在进行的通话');
    this.joining = this.join(request.targetId, AbortSignal.any([this.lifecycle.signal, ...(signal ? [signal] : [])]));
    try { return await this.joining; } finally { this.joining = undefined; }
  }
  private async join(targetId: string, signal: AbortSignal) {
    const rooms = await this.api('voice/list', undefined, signal);
    if (!Array.isArray(rooms?.items)) throw new RtcError('KOOK_PROTOCOL', 'KOOK 返回无效的已加入频道列表');
    if (rooms.items.length) throw new RtcError('ACCOUNT_BUSY', 'KOOK 账号已在语音频道中，不能接管其他应用的通话');
    signal.throwIfAborted();
    const now = Date.now(), random = randomBytes(10);
    let finishInit!: () => void; const initDone = new Promise<void>(resolve => { finishInit = resolve; });
    const a: Active = { snapshot: { id: `${this.id}:${randomUUID()}`, providerId: this.id, account: this.account, kind: 'group', targetId, direction: 'outgoing', state: 'connecting', createdAt: now, updatedAt: now, participants: [], muted: false }, queue: [], queuedBytes: 0, seen: new Set(), sequence: random.readUInt16BE(0), timestamp: random.readUInt32BE(2), ssrc: random.readUInt32BE(6), pt: 111, sentPackets: 0, sentOctets: 0, lastSr: 0, port: 0, rtcpPort: 0, ip: '', closed: false, ticking: false, generation: 0, keeping: false, abort: new AbortController(), initDone, finishInit, attemptedJoin: false };
    this.active = a; this.publish(a);
    signal = AbortSignal.any([signal, a.abort.signal]);
    try {
      const codec = await this.codec();
      if (signal.aborted || a.closed) { codec.delete(); signal.throwIfAborted(); throw new RtcError('CALL_ENDED', 'KOOK 通话已取消'); }
      a.codec = codec; a.attemptedJoin = true;
      // An aborted HTTP request can still allocate a room. Always issue bounded leave on failure.
      const joined = await this.api('voice/join', { channel_id: targetId, audio_ssrc: String(a.ssrc), audio_pt: '111', rtcp_mux: true, ...(this.config.channelPasswords?.[targetId] ? { password: this.config.channelPasswords[targetId] } : {}) }, signal);
      signal.throwIfAborted(); a.abort.signal.throwIfAborted();
      a.ip = joined?.ip; a.port = Number(joined?.port); a.rtcpPort = joined?.rtcp_mux === true ? a.port : Number(joined?.rtcp_port);
      a.ssrc = Number(joined?.audio_ssrc); a.pt = Number(joined?.audio_pt); const bitrate = Number(joined?.bitrate);
      if (!isIP(a.ip) || ![a.port, a.rtcpPort].every(n => Number.isInteger(n) && n >= 1 && n <= 65535) || !Number.isInteger(a.ssrc) || a.ssrc < 0 || a.ssrc > 0xffffffff || !Number.isInteger(a.pt) || a.pt < 96 || a.pt > 127 || !Number.isInteger(bitrate) || bitrate < 6000 || bitrate > 510000) throw new RtcError('KOOK_PROTOCOL', 'KOOK 返回无效的 RTP 参数');
      a.codec.encoderCTL(4002, bitrate); // OPUS_SET_BITRATE_REQUEST
      a.codec.encoderCTL(4006, 0); // OPUS_SET_VBR_REQUEST: comply with the server rate budget.
      a.socket = (this.deps.socket ?? (family => createSocket(family)))(isIP(a.ip) === 6 ? 'udp6' : 'udp4');
      a.socket.on('error', e => { if (!a.closed) void this.close(a, 'failed', this.safe(e)).catch(e => this.error(e)); });
      await new Promise<void>((resolve, reject) => { a.socket!.once('error', reject); a.socket!.bind(0, () => { a.socket!.off('error', reject); resolve(); }); });
      signal.throwIfAborted(); a.abort.signal.throwIfAborted();
      a.snapshot.state = 'connected'; this.publish(a);
      a.cancelTick = (this.deps.every ?? every)(() => { void this.tick(a); }, 20);
      a.cancelKeepalive = (this.deps.every ?? every)(() => {
        if (a.closed || a.keeping) return; a.keeping = true;
        void this.api('voice/keep-alive', { channel_id: targetId }, a.abort.signal).catch(e => { if (!a.closed) return this.close(a, 'failed', this.safe(e)); }).catch(e => this.error(e)).finally(() => { a.keeping = false; });
      }, 40000);
      a.finishInit(); return clone(a.snapshot);
    } catch (e) {
      a.finishInit();
      if (a.attemptedJoin || a.closeTask) await this.close(a, 'failed', this.safe(e)).catch(e => this.error(e));
      else this.release(a, 'failed', this.safe(e));
      throw new RtcError('KOOK_JOIN_FAILED', this.safe(e));
    } finally { a.finishInit(); }
  }
  private current(id: string) { const a = this.active; if (!a || a.snapshot.id !== id || a.closed) throw new RtcError('CALL_ENDED', 'KOOK 通话已结束'); return a; }
  async accept(_id: string) { throw new RtcError('UNSUPPORTED', 'KOOK Bot 不支持私聊来电'); }
  async reject(_id: string) { throw new RtcError('UNSUPPORTED', 'KOOK Bot 不支持私聊来电'); }
  async hangup(id: string) { await this.close(this.current(id), 'ended'); }
  async setMuted(id: string, muted: boolean) { const a = this.current(id); a.snapshot.muted = muted; if (muted) await this.clearAudio(id); this.publish(a); }
  async writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt> {
    validateAudio(frame); const a = this.current(frame.callId);
    if (a.snapshot.state !== 'connected') throw new RtcError('NOT_CONNECTED', 'KOOK 尚未加入频道');
    if (frame.sampleRate !== 48000 || frame.channels !== 2) throw new RtcError('AUDIO_FORMAT', 'KOOK 需要 48 kHz 双声道 PCM');
    if (a.snapshot.muted) throw new RtcError('MUTED', '发送已静音');
    if (a.seen.has(playbackId)) throw new RtcError('DUPLICATE_PLAYBACK', '播放 ID 已使用');
    if (a.queuedBytes + frame.data.byteLength > this.maxQueue) throw new RtcError('QUEUE_FULL', 'KOOK 音频队列已满');
    const receipt: PlaybackReceipt = { id: playbackId, callId: frame.callId, acceptedBytes: frame.data.byteLength, playedBytes: 0, dispatchedBytes: 0, state: 'queued', evidence: 'kook-local-rtp-dispatch' };
    a.seen.add(playbackId); if (a.seen.size > 4096) a.seen.delete(a.seen.values().next().value!);
    a.queue.push({ data: Buffer.from(frame.data), offset: 0, receipt }); a.queuedBytes += frame.data.byteLength; return clone(receipt);
  }
  async clearAudio(id: string) { if (this.history.has(id) && terminalStates.has(this.history.get(id)!.state)) return; const a = this.current(id); a.generation++; this.cancel(a, 'cancelled'); }
  private cancel(a: Active, state: 'cancelled' | 'failed') { for (const e of a.queue.splice(0)) { e.receipt.state = state; this.emit({ type: 'playback', playback: clone(e.receipt) }); } a.queuedBytes = 0; }
  private send(a: Active, bytes: Buffer, port: number) { return new Promise<void>((resolve, reject) => a.socket!.send(bytes, port, a.ip, e => e ? reject(e) : resolve())); }
  private async tick(a: Active) {
    if (a.closed || a.snapshot.state !== 'connected' || a.ticking || a.snapshot.muted || !a.queue.length) return;
    a.ticking = true; const generation = a.generation;
    try {
      const pcm = Buffer.alloc(PCM_BYTES); let copied = 0; const portions: Array<{ entry: Entry; bytes: number }> = [];
      for (const entry of a.queue) { const bytes = Math.min(PCM_BYTES - copied, entry.data.length - entry.offset); entry.data.copy(pcm, copied, entry.offset, entry.offset + bytes); copied += bytes; portions.push({ entry, bytes }); if (copied === PCM_BYTES) break; }
      const opus = a.codec!.encode(pcm, 960), packet = Buffer.alloc(12 + opus.length);
      packet[0] = 0x80; packet[1] = a.pt; packet.writeUInt16BE(a.sequence, 2); packet.writeUInt32BE(a.timestamp, 4); packet.writeUInt32BE(a.ssrc, 8); opus.copy(packet, 12);
      await this.send(a, packet, a.port);
      a.sequence = (a.sequence + 1) & 0xffff; a.timestamp = (a.timestamp + 960) >>> 0; a.sentPackets++; a.sentOctets += opus.length;
      if (a.closed || generation !== a.generation) return;
      for (const { entry, bytes } of portions) { entry.offset += bytes; a.queuedBytes -= bytes; entry.receipt.dispatchedBytes = entry.offset; entry.receipt.state = entry.offset === entry.data.length ? 'dispatched' : 'playing'; if (entry.receipt.state === 'dispatched') a.queue.shift(); this.emit({ type: 'playback', playback: clone(entry.receipt) }); }
      if (Date.now() - a.lastSr > 5000) { a.lastSr = Date.now(); await this.send(a, rtcpSenderReport(a.ssrc, a.timestamp, a.sentPackets, a.sentOctets, a.lastSr), a.rtcpPort); }
    } catch (e) { if (!a.closed) await this.close(a, 'failed', this.safe(e)).catch(e => this.error(e)); }
    finally { a.ticking = false; }
  }
  private releaseLocal(a: Active) {
    a.cancelTick?.(); a.cancelKeepalive?.(); a.generation++; this.cancel(a, 'cancelled');
    const socket = a.socket; a.socket = undefined; try { socket?.close(); } catch {}
    const codec = a.codec; a.codec = undefined; codec?.delete();
  }
  private release(a: Active, state: 'ended' | 'failed', error?: string) {
    if (a.closed) return; a.closed = true; a.abort.abort(); a.cancelTick?.(); a.cancelKeepalive?.(); a.generation++; this.cancel(a, state === 'failed' ? 'failed' : 'cancelled');
    this.releaseLocal(a);
    a.snapshot.state = state; a.snapshot.error = error; this.publish(a); if (this.active === a) this.active = undefined;
  }
  private close(a: Active, state: 'ended' | 'failed', error?: string): Promise<void> {
    if (a.closeTask) return a.closeTask;
    if (a.closed) return Promise.resolve();
    a.snapshot.state = 'ending'; this.publish(a); a.cancelTick?.(); a.cancelKeepalive?.(); a.abort.abort();
    // Keep the account occupied until any earlier join HTTP request and codec
    // initialization settle. A stale leave must never terminate a newer call.
    a.closeTask = (async () => {
      await a.initDone;
      try {
        if (a.attemptedJoin) await this.api('voice/leave', { channel_id: a.snapshot.targetId });
        this.release(a, state, error);
      } catch (e) {
        this.releaseLocal(a); a.snapshot.state = 'ending'; a.snapshot.error = 'KOOK 离开未确认：' + this.safe(e); this.publish(a); throw e;
      }
    })().finally(() => { a.closeTask = undefined; });
    return a.closeTask;
  }
  async diagnostics(): Promise<Diagnostic[]> { return [
    { id: 'identity', level: this.available ? 'ok' : 'error', message: this.available ? `KOOK 账号身份已校验：${this.account.selfId}` : 'KOOK 未完成登录' },
    { id: 'allowlist', level: this.allowed.size ? 'ok' : 'warning', message: `允许加入 ${this.allowed.size} 个频道` },
    { id: 'media', level: 'warning', message: '官方接口仅支持 Opus/RTP 推流；没有收音、视频和远端已播放回执' },
    ...(this.lastError ? [{ id: 'last-error', level: 'error' as const, message: this.lastError }] : []),
  ]; }
}
/** Compound SR+SDES, same UDP source port as RTP (RFC 3550). */
export function rtcpSenderReport(ssrc: number, timestamp: number, packets: number, octets: number, now: number) {
  const sr = Buffer.alloc(28); sr[0] = 0x80; sr[1] = 200; sr.writeUInt16BE(6, 2); sr.writeUInt32BE(ssrc, 4);
  sr.writeUInt32BE((Math.floor(now / 1000) + 2208988800) >>> 0, 8); sr.writeUInt32BE(Math.floor((now % 1000) / 1000 * 0x100000000) >>> 0, 12);
  sr.writeUInt32BE(timestamp >>> 0, 16); sr.writeUInt32BE(packets >>> 0, 20); sr.writeUInt32BE(octets >>> 0, 24);
  const cname = Buffer.from(`rtc-${ssrc}`), sdes = Buffer.alloc(Math.ceil((8 + 2 + cname.length + 1) / 4) * 4);
  sdes[0] = 0x81; sdes[1] = 202; sdes.writeUInt16BE(sdes.length / 4 - 1, 2); sdes.writeUInt32BE(ssrc, 4); sdes[8] = 1; sdes[9] = cname.length; cname.copy(sdes, 10);
  return Buffer.concat([sr, sdes]);
}

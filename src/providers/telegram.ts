import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { RtcError, unavailableCapabilities, validateAudio, validateVideo, validateVideoWrite, validateVideoWriteReceipt } from '../core.js';
import { terminalStates, type Account, type AudioFrame, type CallProvider, type CallRequest, type CallSnapshot, type Capabilities, type Diagnostic, type PlaybackReceipt, type ProviderEvent, type VideoFrame, type VideoKind, type VideoSendRequest, type VideoSource, type VideoState, type VideoSubscribeRequest, type VideoTrack, type VideoWriteFrame } from '../types.js';

export interface TelegramConfig {
  id: string; selfId: string; python: string; configPath: string;
  allowedChatIds: string[]; maxQueueMs?: number;
}
export interface TelegramTransport {
  start(config: TelegramConfig, receive: (packet: any) => void, disconnected: () => void): Promise<any>;
  request(op: string, args: object): Promise<any>;
  stop(): Promise<void>;
}
export interface TelegramDependencies { transport?: TelegramTransport; every?: (callback: () => void, ms: number) => () => void }
const copy = <T>(value: T): T => structuredClone(value);
const chatId = (id: unknown): id is string => typeof id === 'string' && /^-?[1-9]\d{0,16}$/.test(id) && Number.isSafeInteger(Number(id));
const sidecarPath = () => [new URL('../bridge/telegram/sidecar.py', import.meta.url), new URL('../../bridge/telegram/sidecar.py', import.meta.url)].map(url => fileURLToPath(url)).find(existsSync);

/** One owned Python process, JSONL only. No TCP listener and no login prompts. */
export class TelegramStdioTransport implements TelegramTransport {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private receive?: (packet: any) => void;
  private disconnected?: () => void;
  private buffer = Buffer.alloc(0);
  private ending = false;
  async start(config: TelegramConfig, receive: (packet: any) => void, disconnected: () => void) {
    const script = sidecarPath();
    if (!script) throw new RtcError('DEPENDENCY_MISSING', '找不到 Telegram sidecar.py，请使用完整安装包。');
    this.receive = receive; this.disconnected = disconnected; this.ending = false; this.buffer = Buffer.alloc(0);
    const child = spawn(config.python, ['-u', '-B', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      if (child !== this.child) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 1024 * 1024) return this.fail();
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
        try {
          const packet = JSON.parse(line.toString('utf8'));
          if (packet.type === 'reply') {
            const pending = this.pending.get(packet.id); if (!pending) continue;
            this.pending.delete(packet.id); clearTimeout(pending.timer);
            if (packet.ok === true) pending.resolve(packet.data);
            else pending.reject(new RtcError(typeof packet.error?.code === 'string' ? packet.error.code : 'TELEGRAM_SDK_ERROR', typeof packet.error?.message === 'string' ? packet.error.message.slice(0, 300) : 'Telegram 操作失败。'));
          } else this.receive?.(packet);
        } catch { this.fail(); return; }
      }
    });
    // Sidecar logs are intentionally not forwarded or persisted: SDK exceptions
    // and stderr may contain identifiers or credentials. Diagnostics stay generic.
    child.stderr.resume();
    child.on('error', () => this.fail());
    child.on('close', () => { if (this.child === child) { this.child = undefined; this.fail(false); } });
    return this.request('start', { configPath: config.configPath, selfId: config.selfId, providerId: config.id, allowedChatIds: config.allowedChatIds });
  }
  private fail(kill = true) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new RtcError('TELEGRAM_DISCONNECTED', 'Telegram sidecar 连接失效；已提交操作的结果未知。')); }
    this.pending.clear();
    if (kill) this.child?.kill();
    if (!this.ending) this.disconnected?.();
  }
  request(op: string, args: object): Promise<any> {
    const child = this.child;
    if (!child || child.killed || child.stdin.destroyed || this.ending) return Promise.reject(new RtcError('TELEGRAM_OFFLINE', 'Telegram sidecar 未运行。'));
    const id = randomUUID(), packet = JSON.stringify({ id, op, args }) + '\n';
    if (this.pending.size >= 24 || Buffer.byteLength(packet) + child.stdin.writableLength > 768 * 1024) return Promise.reject(new RtcError('BACKPRESSURE', 'Telegram IPC 队列已满。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RtcError('RESULT_UNKNOWN', 'Telegram 操作超时；请检查实际通话状态，不要重放。')); this.fail(); }, op === 'start' ? 45000 : 15000); timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(packet, error => { if (error) this.fail(); });
    });
  }
  async stop() {
    this.ending = true; const child = this.child;
    this.fail(false);
    if (!child) return;
    child.stdin.end();
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(force); clearTimeout(kill); resolve(); } };
      const kill = setTimeout(() => child.kill(), 6000);
      const force = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 8000);
      child.once('close', finish); if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    if (this.child === child) this.child = undefined;
  }
}
interface PendingAudio { data: Buffer; offset: number; receipt: PlaybackReceipt }

/** Telegram ordinary-user MTProto + PyTgCalls. Bot API tokens are not accepted. */
export class TelegramProvider implements CallProvider {
  readonly id: string;
  readonly account: Account;
  readonly events = new EventEmitter();
  readonly audioFormat = { encoding: 'pcm_s16le', sampleRate: 48000, channels: 2 } as const;
  private transport: TelegramTransport;
  private snapshots = new Map<string, CallSnapshot>();
  private subscriptions = new Map<string, Map<string, VideoTrack>>();
  private allowed: Set<string>;
  private available = false;
  private stopped = true;
  private starting?: Promise<void>;
  private shutdown?: Promise<void>;
  private stopClock?: () => void;
  private heartbeat?: NodeJS.Timeout;
  private pinging = false;
  private queue: PendingAudio[] = [];
  private queuedBytes = 0;
  private audioBusy?: Promise<void>;
  private clearing = new Set<string>();
  private usedPlayback = new Set<string>();
  private lastError?: string;
  private generation = 0;
  private maxBytes: number;
  constructor(private config: TelegramConfig, private deps: TelegramDependencies = {}) {
    if (!/^[\w.-]{1,80}$/.test(config.id) || !chatId(config.selfId) || config.selfId.startsWith('-') || typeof config.python !== 'string' || !config.python || typeof config.configPath !== 'string' || !isAbsolute(config.configPath) || !Array.isArray(config.allowedChatIds) || config.allowedChatIds.length > 512 || config.allowedChatIds.some(id => !chatId(id) || id === config.selfId)) throw new RtcError('INVALID_CONFIG', 'Telegram 需要有效用户 ID、Python、配置绝对路径和聊天 ID 白名单。');
    const maxMs = config.maxQueueMs ?? 2000;
    if (!Number.isInteger(maxMs) || maxMs < 10 || maxMs > 10000) throw new RtcError('INVALID_CONFIG', 'Telegram 音频队列上限必须为 10–10000 毫秒。');
    this.id = config.id; this.account = { platform: 'telegram', selfId: config.selfId }; this.allowed = new Set(config.allowedChatIds); this.maxBytes = maxMs * 192;
    this.transport = deps.transport ?? new TelegramStdioTransport();
  }
  private emit(event: ProviderEvent) { this.events.emit('event', event); }
  capabilities(): Capabilities {
    const result = unavailableCapabilities(this.available ? 'Telegram 群混音不保证单一说话人身份' : 'Telegram 普通用户会话尚未连接并校验身份');
    if (this.available && this.allowed.size) for (const key of ['dial', 'dialScreen', 'accept', 'reject', 'hangup', 'joinGroup', 'startGroup', 'leaveGroup', 'receiveAudio', 'sendAudio', 'receiveVideo', 'sendVideo', 'shareScreen', 'participants', 'mute'] as const) result[key] = { supported: true };
    if (this.available && !this.allowed.size) for (const value of Object.values(result)) value.reason = '请先配置允许通话的 Telegram 用户或群 ID';
    return result;
  }
  calls() { return [...this.snapshots.values()].map(copy); }
  async channels() {
    this.online();
    return [...this.allowed].map(id => ({ id, name: `${id.startsWith('-') ? 'Telegram 群' : 'Telegram 用户'} ${id}`, kind: id.startsWith('-') ? 'group' as const : 'direct' as const }));
  }
  private online() { if (!this.available) throw new RtcError('TELEGRAM_OFFLINE', 'Telegram 普通用户会话未连接。'); }
  private current(id: string, connected = false) {
    this.online(); const call = this.snapshots.get(id);
    if (!call || terminalStates.has(call.state)) throw new RtcError('CALL_ENDED', 'Telegram 通话已经结束。');
    if (connected && call.state !== 'connected') throw new RtcError('NOT_CONNECTED', 'Telegram 通话尚未连接。'); return call;
  }
  private update(raw: any) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.startsWith(`${this.id}:`) || raw.id.length > 200 || raw.providerId !== this.id || raw.account?.selfId !== this.account.selfId || raw.account?.platform !== 'telegram' || !this.allowed.has(raw.targetId) || !['direct','group'].includes(raw.kind) || (raw.kind === 'direct') !== !raw.targetId.startsWith('-') || !['incoming','outgoing'].includes(raw.direction) || !['ringing','dialing','connecting','connected','ending','ended','failed'].includes(raw.state) || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt) || !Array.isArray(raw.participants) || raw.participants.length > 10000 || raw.participants.some((p: any) => !chatId(p.id) || p.identity !== 'platform') || typeof raw.muted !== 'boolean') throw new RtcError('INVALID_CALL', 'Telegram 返回了不匹配的通话身份。');
    if (terminalStates.has(this.snapshots.get(raw.id)?.state as any)) return;
    const call: CallSnapshot = { id: raw.id, providerId: this.id, account: this.account, kind: raw.kind, targetId: raw.targetId, direction: raw.direction, state: raw.state, createdAt: raw.createdAt, updatedAt: raw.updatedAt, muted: raw.muted, participants: raw.participants.map((p: any) => ({ id: p.id, identity: 'platform' })), ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 300) } : {}) };
    this.snapshots.set(call.id, copy(call));
    if (call.state !== 'connected') { this.cancel(call.id); this.subscriptions.delete(call.id); }
    else for (const [id, track] of this.subscriptions.get(call.id) ?? []) if (!call.participants.some(p => p.id === track.participantId)) this.subscriptions.get(call.id)!.delete(id);
    this.emit({ type: 'call', call: copy(call) });
    const ended = [...this.snapshots.values()].filter(c => terminalStates.has(c.state)); for (const old of ended.slice(0, -100)) this.snapshots.delete(old.id);
  }
  private packet(packet: any) {
    try {
      if (packet.type === 'offline') { this.disconnect(); return; }
      if (packet.type === 'call') { this.update(packet.call); return; }
      if (packet.type !== 'audio' && packet.type !== 'video') return;
      const raw = packet.frame, call = this.snapshots.get(raw?.callId);
      if (!this.available || call?.state !== 'connected' || typeof raw.data !== 'string' || raw.data.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) return;
      if (packet.type === 'audio') {
        const frame: AudioFrame = { callId: call.id, encoding: raw.encoding, channels: raw.channels, sampleRate: raw.sampleRate, sequence: raw.sequence, timestamp: raw.timestamp, data: Buffer.from(raw.data, 'base64') };
        validateAudio(frame); if (frame.sampleRate !== 48000 || frame.channels !== 2) return; this.emit({ type: 'audio', audio: frame });
      } else {
        const track = this.subscriptions.get(call.id)?.get(raw.trackId);
        if (raw.evidence !== 'ntgcalls-decoded-frame-and-jpeg-encode' || !track || track.participantId !== raw.participantId || track.kind !== raw.kind || !call.participants.some(p => p.id === raw.participantId)) return;
        const frame: VideoFrame = { callId: call.id, trackId: raw.trackId, participantId: raw.participantId, kind: raw.kind, encoding: raw.encoding, width: raw.width, height: raw.height, sequence: raw.sequence, timestamp: raw.timestamp, evidence: raw.evidence, data: Buffer.from(raw.data, 'base64') };
        validateVideo(frame); this.emit({ type: 'video', video: frame });
      }
    } catch { this.lastError = 'Telegram 拒绝了无效的媒体或通话数据'; if (packet.type === 'call') this.disconnect(); }
  }
  private closeTransport() { return this.shutdown ??= this.transport.stop(); }
  private disconnect() {
    if (!this.available && this.stopped) return;
    this.available = false; this.lastError = 'Telegram sidecar 或网络已断开；请显式重启后端'; this.generation++;
    for (const call of [...this.snapshots.values()]) if (!terminalStates.has(call.state)) this.update({ ...call, state: 'failed', error: this.lastError, updatedAt: Date.now() });
    this.stopClock?.(); this.stopClock = undefined; clearInterval(this.heartbeat); this.heartbeat = undefined;
    void this.closeTransport().catch(() => {});
    this.emit({ type: 'availability' });
  }
  async start() {
    if (this.starting) return this.starting; if (!this.stopped) return;
    this.stopped = false; this.shutdown = undefined; const generation = ++this.generation;
    this.starting = (async () => {
      try {
        const result = await this.transport.start(this.config, packet => { if (generation === this.generation) this.packet(packet); }, () => this.disconnect());
        if (this.stopped || generation !== this.generation) throw new RtcError('DISPOSED', 'Telegram 启动已取消。');
        if (result?.selfId !== this.account.selfId || result?.platform !== 'telegram' || result?.bot !== false) throw new RtcError('IDENTITY_MISMATCH', 'Telegram 登录账号不是配置的普通用户。');
        this.available = true; this.lastError = undefined;
        this.stopClock = (this.deps.every ?? ((fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); }))(() => this.tick(), 10);
        this.heartbeat = setInterval(() => { if (this.pinging || !this.available) return; this.pinging = true; void this.transport.request('ping', {}).then(result => { if (result?.connected !== true) this.disconnect(); }, () => this.disconnect()).finally(() => { this.pinging = false; }); }, 5000); this.heartbeat.unref();
        this.emit({ type: 'availability' });
      } catch (error) { this.disconnect(); this.stopped = true; await this.closeTransport(); throw error; }
      finally { this.starting = undefined; }
    })(); return this.starting;
  }
  async stop() {
    this.stopped = true; this.disconnect(); this.stopClock?.(); this.stopClock = undefined; clearInterval(this.heartbeat); this.heartbeat = undefined;
    await this.closeTransport(); await this.audioBusy?.catch(() => {}); this.usedPlayback.clear();
  }
  async dial(request: CallRequest, signal?: AbortSignal) {
    this.online(); signal?.throwIfAborted();
    if (!this.allowed.has(request.targetId)) throw new RtcError('CHAT_NOT_ALLOWED', 'Telegram 通话目标不在白名单内。');
    if (!['direct','group'].includes(request.kind) || (request.kind === 'direct') !== !request.targetId.startsWith('-') || !['audio','video','screen'].includes(request.media ?? 'audio') || request.kind === 'group' && (request.media ?? 'audio') !== 'audio' || request.groupMode !== undefined && !['join','create'].includes(request.groupMode) || request.inviteeIds?.length) throw new RtcError('INVALID_REQUEST', 'Telegram 目标类型或通话请求无效；群通话不支持此处批量邀请。');
    if ([...this.snapshots.values()].some(c => !terminalStates.has(c.state))) throw new RtcError('ACCOUNT_BUSY', 'Telegram 账号已有通话。');
    const result = await this.transport.request('dial', request); this.update(result);
    if (signal?.aborted) { await this.hangup(result.id).catch(() => {}); signal.throwIfAborted(); }
    return copy(this.snapshots.get(result.id)!);
  }
  async accept(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.current(id); await this.transport.request('accept', { callId: id }); }
  async reject(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.current(id); await this.transport.request('reject', { callId: id }); }
  async hangup(id: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.current(id); this.cancel(id); await this.transport.request('hangup', { callId: id }); }
  private playback(job: PendingAudio, state: PlaybackReceipt['state']) { job.receipt.state = state; this.emit({ type: 'playback', playback: copy(job.receipt) }); }
  private cancel(id: string) {
    for (const job of this.queue.filter(j => j.receipt.callId === id)) { this.queuedBytes -= job.data.length - job.offset; this.playback(job, 'cancelled'); }
    this.queue = this.queue.filter(j => j.receipt.callId !== id);
  }
  async writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt> {
    const call = this.current(frame.callId, true); validateAudio(frame);
    if (frame.sampleRate !== 48000 || frame.channels !== 2) throw new RtcError('INVALID_AUDIO', 'Telegram 需要 48 kHz 双声道 PCM S16LE。');
    if (call.muted || this.clearing.has(call.id)) throw new RtcError('MUTED', 'Telegram 正在静音或清理音频。');
    if (!playbackId || playbackId.length > 160 || this.usedPlayback.has(playbackId)) throw new RtcError('INVALID_PLAYBACK_ID', '播放 ID 已使用或无效。');
    if (this.queuedBytes + frame.data.byteLength > this.maxBytes || this.queue.length >= 256) throw new RtcError('BACKPRESSURE', 'Telegram 音频队列已满。');
    const receipt: PlaybackReceipt = { id: playbackId, callId: call.id, acceptedBytes: frame.data.byteLength, playedBytes: 0, dispatchedBytes: 0, state: 'queued', evidence: 'ntgcalls-input-submit' };
    this.usedPlayback.add(playbackId); if (this.usedPlayback.size > 1024) this.usedPlayback.delete(this.usedPlayback.values().next().value!);
    this.queue.push({ data: Buffer.from(frame.data), offset: 0, receipt }); this.queuedBytes += frame.data.byteLength;
    this.emit({ type: 'playback', playback: copy(receipt) }); return copy(receipt);
  }
  private tick() {
    if (this.audioBusy || !this.available || !this.queue.length) return;
    const id = this.queue[0]!.receipt.callId;
    if (this.clearing.has(id) || this.snapshots.get(id)?.muted) return;
    const data = Buffer.alloc(1920), parts: Array<{job: PendingAudio; count: number}> = []; let copied = 0;
    for (const job of this.queue) {
      if (job.receipt.callId !== id || copied === 1920) break;
      const count = Math.min(1920 - copied, job.data.length - job.offset);
      job.data.copy(data, copied, job.offset, job.offset + count); copied += count; parts.push({ job, count });
    }
    this.audioBusy = (async () => {
      try {
        const result = await this.transport.request('audio.write', { callId: id, data: data.toString('base64') });
        if (result?.submittedBytes !== 1920) throw new Error('Invalid native audio acknowledgement');
        for (const {job, count} of parts) {
          // A clear can cancel the rest while this one submission is in flight.
          job.receipt.dispatchedBytes = (job.receipt.dispatchedBytes ?? 0) + count;
          const index = this.queue.indexOf(job);
          if (index < 0) { this.emit({ type: 'playback', playback: copy(job.receipt) }); continue; }
          job.offset += count; this.queuedBytes -= count;
          if (job.offset === job.data.length) { this.queue.splice(index, 1); this.playback(job, 'dispatched'); }
          else this.playback(job, 'playing');
        }
      } catch {
        for (const {job} of parts) {
          const index = this.queue.indexOf(job);
          if (index >= 0) { this.queuedBytes -= job.data.length - job.offset; this.queue.splice(index, 1); job.receipt.error = 'Telegram native audio submission failed'; this.playback(job, 'failed'); }
        }
        this.cancel(id);
      }
    })().finally(() => { this.audioBusy = undefined; });
  }
  async clearAudio(id: string) {
    const known = this.snapshots.get(id);
    this.cancel(id);
    if (known && terminalStates.has(known.state)) { await this.audioBusy; return; }
    this.current(id); this.clearing.add(id);
    try { await this.audioBusy; await this.transport.request('audio.clear', { callId: id }); } finally { this.clearing.delete(id); }
  }
  async setMuted(id: string, muted: boolean) {
    this.current(id);
    if (!muted) { await this.transport.request('mute', { callId: id, muted }); return; }
    this.clearing.add(id); this.cancel(id);
    try { await this.audioBusy; await this.transport.request('audio.clear', { callId: id }); await this.transport.request('mute', { callId: id, muted }); }
    finally { this.clearing.delete(id); }
  }
  private track(raw: any): VideoTrack {
    if (!raw || typeof raw.trackId !== 'string' || !raw.trackId || raw.trackId.length > 512 || !chatId(raw.participantId) || !['camera','screen'].includes(raw.kind) || ![true,false,null].includes(raw.available) || typeof raw.subscribed !== 'boolean' || typeof raw.hasFrame !== 'boolean') throw new RtcError('INVALID_VIDEO', 'Telegram 视频轨道无效。');
    return { trackId: raw.trackId, participantId: raw.participantId, kind: raw.kind, available: raw.available, subscribed: raw.subscribed, hasFrame: raw.hasFrame, ...(Number.isInteger(raw.width) && raw.width > 0 ? { width: raw.width } : {}), ...(Number.isInteger(raw.height) && raw.height > 0 ? { height: raw.height } : {}), firstFrameAt: null, decodedFrameAt: Number.isFinite(raw.decodedFrameAt) ? raw.decodedFrameAt : null };
  }
  private state(id: string, raw: any): VideoState {
    if (!raw || raw.callId !== id || raw.supported !== true || !Array.isArray(raw.tracks) || raw.tracks.length > 64 || !raw.sending || typeof raw.sending !== 'object') throw new RtcError('INVALID_VIDEO', 'Telegram 视频状态不属于此通话。');
    const sending: VideoState['sending'] = {};
    for (const kind of ['camera','screen'] as const) if (raw.sending[kind]) {
      const value = raw.sending[kind];
      if (value.sourceId !== 'external-frames' || !['starting','sending','stopping','failed'].includes(value.state) || value.framing !== undefined && !['full','portrait-safe'].includes(value.framing)) throw new RtcError('INVALID_VIDEO', 'Telegram 视频输出状态无效。');
      sending[kind] = { sourceId: value.sourceId, state: value.state, ...(value.framing === undefined ? {} : { framing: value.framing }), ...(typeof value.evidence === 'string' ? { evidence: value.evidence } : {}) };
    }
    return { callId: id, supported: true, tracks: raw.tracks.map((track: any) => this.track(track)), sending };
  }
  async videoState(id: string) { this.current(id, true); return this.state(id, await this.transport.request('video.state', { callId: id })); }
  async videoSources(id: string): Promise<VideoSource[]> { this.current(id, true); return ['camera','screen'].map(kind => ({ id: 'external-frames', kind: kind as VideoKind, name: '消费插件提供的 JPEG 帧', sourceType: 'frames', channels: [kind as VideoKind] })); }
  async subscribeVideo(id: string, request: VideoSubscribeRequest) {
    const call = this.current(id, true); if (!['camera','screen'].includes(request.kind) || !call.participants.some(p => p.id === request.participantId)) throw new RtcError('INVALID_TRACK', '请选择当前 Telegram 成员。');
    const raw = await this.transport.request('video.subscribe', { callId: id, ...request }); this.current(id, true); const track = this.track(raw);
    if (track.participantId !== request.participantId || track.kind !== request.kind || !track.subscribed) throw new RtcError('INVALID_VIDEO', 'Telegram 订阅回执不匹配。');
    if (!this.subscriptions.has(id)) this.subscriptions.set(id, new Map()); this.subscriptions.get(id)!.set(track.trackId, track); return copy(track);
  }
  async unsubscribeVideo(id: string, trackId: string) { this.subscriptions.get(id)?.delete(trackId); this.current(id); await this.transport.request('video.unsubscribe', { callId: id, trackId }); }
  async sendVideo(id: string, request: VideoSendRequest) {
    this.current(id, true); if (!['camera','screen'].includes(request.kind) || request.sourceId !== 'external-frames' || request.framing !== undefined && (request.kind !== 'camera' || !['full','portrait-safe'].includes(request.framing))) throw new RtcError('INVALID_SOURCE', 'Telegram 仅接收明确选择的外部 JPEG 来源。');
    return this.state(id, await this.transport.request('video.send', { callId: id, ...request }));
  }
  async stopVideo(id: string, kind: VideoKind) { this.current(id); return this.state(id, await this.transport.request('video.stop', { callId: id, kind })); }
  async clearVideo(id: string) { this.subscriptions.delete(id); const call = this.snapshots.get(id); if (!this.available || !call || terminalStates.has(call.state)) return; await this.transport.request('video.clear', { callId: id }); }
  async writeVideo(frame: VideoWriteFrame) { this.current(frame.callId, true); validateVideoWrite(frame); const result = await this.transport.request('video.write', { ...frame, data: Buffer.from(frame.data).toString('base64') }); this.current(frame.callId, true); validateVideoWriteReceipt(result, frame); return result; }
  async diagnostics(): Promise<Diagnostic[]> {
    return [{ id: 'telegram-account', level: this.available ? 'ok' : 'error', message: this.available ? 'Telegram 普通账号会话已校验' : this.lastError ?? 'Telegram 尚未连接；请先运行独立登录 CLI' }, { id: 'telegram-scope', level: this.allowed.size ? 'ok' : 'warning', message: `允许 ${this.allowed.size} 个 Telegram 用户/群；输入仅来自消费插件，不打开本机麦克风或摄像头` }, { id: 'telegram-playback', level: 'warning', message: 'dispatched 仅证明 PCM 已提交 NTgCalls；远端播放无法确认，群音频为混音' }];
  }
}

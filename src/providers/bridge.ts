import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import WebSocket from 'ws';
import { RtcError, validateAudio, validateVideo, validateVideoWrite, validateVideoWriteReceipt } from '../core.js';
import { unavailableCapabilities, terminalStates, mediaTransitionBlocksAudio, readVideoSendFailure } from '../types.js';
import type { Account, AudioFrame, CallProvider, CallRequest, CallSnapshot, Capabilities, Diagnostic, PlaybackReceipt, ProviderEvent, VideoFrame, VideoKind, VideoTrack, VideoState, VideoSource, VideoSubscribeRequest, VideoSendRequest, VideoWriteFrame, VideoWriteReceipt, MediaTransition, VideoSendFailure } from '../types.js';

function mediaTransition(raw: any): MediaTransition | undefined {
  if (raw === undefined) return;
  if (!raw || raw.kind !== 'screen' || raw.interruption !== true || !['preparing','closing','negotiating','connecting','restoring','completed','failed','cancelled'].includes(raw.status) || !Number.isFinite(raw.startedAt) || raw.startedAt < 0 || raw.finishedAt !== undefined && (!Number.isFinite(raw.finishedAt) || raw.finishedAt < 0) || raw.audioReady !== undefined && typeof raw.audioReady !== 'boolean') throw new RtcError('INVALID_STATUS', '桥接返回了无效媒体切换状态。');
  return { kind: 'screen', status: raw.status, startedAt: raw.startedAt, interruption: true,
    ...(raw.finishedAt === undefined ? {} : { finishedAt: raw.finishedAt }), ...(raw.audioReady === undefined ? {} : { audioReady: raw.audioReady }),
    ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId.slice(0,128) } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error.slice(0,500) } : {}),
    ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode.slice(0,64) } : {}) };
}

export interface BridgeConfig { id: string; url: string; token: string; selfId: string; platform?: string }
/** Transport only: connection/state acknowledgements are supplied by the desktop bridge. */
export class DesktopBridgeProvider implements CallProvider {
  readonly id: string; readonly account: Account; readonly events = new EventEmitter();
  private verified = false;
  private socket?: WebSocket; private stopped = true; private retry?: NodeJS.Timeout; private epoch = '';
  private capabilitiesValue = unavailableCapabilities('桌面桥接未连接');
  private snapshots = new Map<string, CallSnapshot>(); private remoteIds = new Map<string, string>();
  private videoTracks = new Map<string, Map<string, VideoTrack>>();
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; cleanup(): void; videoSendScope?: Omit<VideoSendFailure, 'outcome'> }>();
  private videoTransitions = new Map<string, string>();
  private notices: Diagnostic[] = [];
  private formatValue?: { sampleRate: number; channels: 1 | 2; encoding: 'pcm_s16le' };
  get audioFormat() { return this.formatValue; }
  constructor(private config: BridgeConfig) {
    const url = new URL(config.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('桥接地址必须是不含凭据的 WebSocket URL');
    if (url.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程桥接必须使用 WSS，或通过 SSH 隧道连接本机端口');
    if (typeof config.token !== 'string' || Buffer.byteLength(config.token) < 32) throw new Error('桥接令牌至少需要 32 字节');
    if (typeof config.id !== 'string' || !config.id || config.id.length > 128 || typeof config.selfId !== 'string' || !config.selfId) throw new Error('桥接后端和账号标识不能为空');
    this.id = config.id; this.account = { platform: config.platform || 'onebot', selfId: config.selfId };
  }
  capabilities() { return structuredClone(this.capabilitiesValue); }
  calls() { return [...this.snapshots.values()].map(c => structuredClone(c)); }
  async start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  private connect() {
    if (this.stopped) return;
    this.epoch = randomUUID(); this.verified = false; this.formatValue = undefined;
    const socket = new WebSocket(this.config.url, { headers: { Authorization: `Bearer ${this.config.token}` }, maxPayload: 512 * 1024, handshakeTimeout: 5000 });
    this.socket = socket;
    let heartbeat: NodeJS.Timeout | undefined, heardAt = Date.now();
    socket.on('open', () => { heardAt = Date.now(); heartbeat = setInterval(() => { if (Date.now() - heardAt > 15000) socket.terminate(); }, 5000); });
    socket.on('ping', () => { heardAt = Date.now(); });
    socket.on('message', (data, binary) => {
      heardAt = Date.now(); if (this.stopped || this.socket !== socket || binary) return;
      try { this.message(JSON.parse(data.toString())); } catch { this.disconnect('桥接返回了无效数据'); socket.close(1008, 'invalid packet'); }
    });
    socket.on('error', () => { if (this.socket !== socket) return; this.notices = [{ id: 'transport', level: 'error', message: '无法连接桌面桥接，请检查地址、令牌与桥接进程' }]; });
    socket.on('close', () => {
      clearInterval(heartbeat);
      if (this.socket !== socket) return;
      this.disconnect('桌面桥接已断开；请在客户端确认实际通话是否结束');
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 2000);
    });
  }
  private disconnect(message: string) {
    this.videoTracks.clear();
    this.verified = false; this.formatValue = undefined;
    this.capabilitiesValue = unavailableCapabilities(message); this.emit({ type: 'availability' });
    for (const [id, c] of this.snapshots) if (!terminalStates.has(c.state)) {
      const failed = { ...c, state: 'failed' as const, error: message, updatedAt: Date.now() };
      this.snapshots.set(id, failed); this.emit({ type: 'call', call: failed });
    }
    for (const p of this.pending.values()) { p.cleanup(); p.reject(new RtcError('BRIDGE_DISCONNECTED', '桥接连接失效，已提交操作的结果未知；请检查实际通话')); }
    this.pending.clear();
  }
  private emit(event: ProviderEvent) { this.events.emit('event', event); }
  private localId(remoteId: string) { return `${this.id}:${this.epoch}:${remoteId}`; }
  private message(packet: any) {
    if (!packet || typeof packet !== 'object') return;
    if (!this.verified && !['hello', 'status'].includes(packet.type)) return;
    if (packet.type === 'reply' && typeof packet.id === 'string') {
      const pending = this.pending.get(packet.id); if (!pending) return;
      this.pending.delete(packet.id); pending.cleanup();
      if (packet.ok === true) pending.resolve(packet.data); else {
        const proof = pending.videoSendScope && readVideoSendFailure(packet.error?.videoSendFailure, pending.videoSendScope);
        pending.reject(Object.assign(new RtcError(String(packet.error?.code || 'BRIDGE_ERROR'), String(packet.error?.message || '桥接操作失败')), proof ? { videoSendFailure: proof } : {}));
      }
    } else if (packet.type === 'hello' || packet.type === 'status') {
      if (packet.version !== 1 || packet.account?.selfId !== this.account.selfId || packet.account?.platform !== this.account.platform) {
        this.notices = [{ id: 'identity', level: 'error', message: '桥接协议或账号与配置不一致' }]; this.disconnect('桥接协议或账号与配置不一致'); this.socket?.close(1008, 'identity mismatch'); return;
      }
      if (!Array.isArray(packet.calls) || packet.calls.length > 256) throw new Error('Invalid call snapshot list');
      this.verified = true;
      const caps = unavailableCapabilities('桥接未声明此能力');
      for (const k of Object.keys(caps) as (keyof Capabilities)[]) {
        const c = packet.capabilities?.[k]; if (c && typeof c.supported === 'boolean') caps[k] = { supported: c.supported, reason: typeof c.reason === 'string' ? c.reason.slice(0, 500) : undefined };
      }
      this.capabilitiesValue = caps;
      this.formatValue = undefined;
      const format = packet.audioFormat; if (format?.encoding === 'pcm_s16le' && [8000,16000,24000,32000,44100,48000].includes(format.sampleRate) && [1,2].includes(format.channels)) this.formatValue = { sampleRate: format.sampleRate, channels: format.channels, encoding: 'pcm_s16le' };
      if (!this.formatValue) for (const key of ['receiveAudio', 'sendAudio'] as const) caps[key] = { supported: false, reason: '桥接未提供有效 PCM 格式' };
      this.notices = Array.isArray(packet.diagnostics) ? packet.diagnostics.filter((d: any) => d && ['ok','warning','error'].includes(d.level) && typeof d.message === 'string').slice(0, 30) : [];
      const present = new Set<string>();
      for (const call of packet.calls) if (this.updateCall(call)) present.add(this.localId(call.id));
      for (const [id, call] of this.snapshots) if (id.startsWith(`${this.id}:${this.epoch}:`) && !terminalStates.has(call.state) && !present.has(id)) {
        const failed = { ...call, state: 'failed' as const, error: '桥接当前快照中已无此通话', updatedAt: Date.now() };
        this.snapshots.set(id, failed); this.emit({ type: 'call', call: failed });
      }
      this.emit({ type: 'availability' });
    } else if (packet.type === 'call') this.updateCall(packet.call);
    else if (packet.type === 'video') {
      const f = packet.frame;
      if (!f || typeof f.callId !== 'string' || typeof f.data !== 'string' || f.data.length > 349528 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) return;
      const id = this.localId(f.callId), call = this.snapshots.get(id), track = this.videoTracks.get(id)?.get(f.trackId);
      if (call?.state !== 'connected' || !this.capabilitiesValue.receiveVideo?.supported || !track || track.participantId !== f.participantId || track.kind !== f.kind ||
        !call.participants.some(member => member.identity === 'platform' && member.id === f.participantId)) return;
      const video: VideoFrame = { callId: id, trackId: f.trackId, participantId: f.participantId, kind: f.kind, encoding: f.encoding,
        width: f.width, height: f.height, sequence: f.sequence, timestamp: f.timestamp, evidence: f.evidence, data: Buffer.from(f.data, 'base64') };
      try { validateVideo(video); } catch { return; }
      this.emit({ type: 'video', video });
    } else if (packet.type === 'audio') {
      const f = packet.frame;
      if (!f || typeof f.callId !== 'string' || typeof f.data !== 'string' || f.data.length > 256000) return;
      if (!this.formatValue || f.encoding !== this.formatValue.encoding || f.sampleRate !== this.formatValue.sampleRate || f.channels !== this.formatValue.channels ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) return;
      const audio: AudioFrame = { ...f, callId: this.localId(f.callId), data: Buffer.from(f.data, 'base64'), speakerId: undefined };
      try { validateAudio(audio); } catch { return; }
      if (this.snapshots.get(audio.callId)?.state !== 'connected') return;
      this.emit({ type: 'audio', audio });
    } else if (packet.type === 'playback' && packet.receipt && typeof packet.receipt.callId === 'string') {
      this.emit({ type: 'playback', playback: { ...packet.receipt, callId: this.localId(packet.receipt.callId) } });
    } else if (packet.type === 'error') this.emit({ type: 'error', error: String(packet.message || '桌面音频桥接发生错误') });
  }
  private updateCall(c: any) {
    if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 160 || !['ringing','dialing','connecting','connected','ending','ended','failed'].includes(c.state)
      || !['direct','group'].includes(c.kind) || !['incoming','outgoing'].includes(c.direction) || typeof c.targetId !== 'string' || c.targetId.length > 512) return false;
    const id = this.localId(c.id), old = this.snapshots.get(id);
    if (old && terminalStates.has(old.state) && !terminalStates.has(c.state)) return false;
    const call: CallSnapshot = { id, providerId: this.id, account: this.account, kind: c.kind, targetId: c.targetId,
      direction: c.direction, state: c.state, createdAt: Number.isFinite(c.createdAt) ? c.createdAt : old?.createdAt ?? Date.now(), updatedAt: Date.now(),
      participants: Array.isArray(c.participants) ? [...new Set<string>(c.participants.filter((p: any) => p && typeof p.id === 'string' && p.id.length < 160 && p.identity === 'platform').map((p: any) => p.id))].sort().slice(0,500).map(id => ({ id, identity: 'platform' as const })) : [], muted: c.muted === true, error: typeof c.error === 'string' ? c.error.slice(0, 500) : undefined };
    call.mediaTransition = mediaTransition(c.mediaTransition);
    if (call.state !== 'connected') this.videoTracks.delete(id);
    else for (const [trackId, track] of this.videoTracks.get(id) ?? []) if (!call.participants.some(member => member.id === track.participantId)) this.videoTracks.get(id)!.delete(trackId);
    if (old) {
      const { updatedAt: _oldTime, ...previous } = old;
      const { updatedAt: _newTime, ...current } = call;
      // Status packets repeat the full call list. A valid unchanged entry is
      // still present, but must not refresh activity or its change timestamp.
      if (isDeepStrictEqual(previous, current)) return true;
    }
    this.remoteIds.set(id, c.id); this.snapshots.set(id, call); this.emit({ type: 'call', call });
    const ended = [...this.snapshots.values()].filter(c => terminalStates.has(c.state));
    for (const stale of ended.slice(0, -100)) { this.snapshots.delete(stale.id); this.remoteIds.delete(stale.id); }
    return true;
  }
  private async request(op: string, args: object = {}, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const socket = this.socket;
    if (this.stopped || !this.verified || !socket || socket.readyState !== WebSocket.OPEN) throw new RtcError('BRIDGE_OFFLINE', '桌面桥接未连接');
    if (this.pending.size >= 100 || socket.bufferedAmount > 512 * 1024) throw new RtcError('BACKPRESSURE', '桥接队列已满');
    const id = randomUUID();
    const remoteCall = op === 'video.send' && (args as any).kind === 'screen' ? (args as any).callId as string : undefined;
    if (remoteCall) this.videoTransitions.set(remoteCall, id);
    // Never retry mutating requests: a timeout means unknown, not unexecuted.
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (remoteCall && this.videoTransitions.get(remoteCall) === id) this.videoTransitions.delete(remoteCall); };
      const fail = (error: Error) => { if (!this.pending.delete(id)) return; cleanup(); reject(error); };
      const abort = () => fail(new RtcError('ABORTED_UNKNOWN', '等待已取消；已提交操作的执行结果未知。'));
      const timer = setTimeout(() => fail(new RtcError('BRIDGE_TIMEOUT', '桥接操作超时，执行结果未知；请检查通话状态')), op === 'video.send' ? 45000 : op.startsWith('video.') ? 25000 : 10000);
      const videoSendScope = op === 'video.send' ? { requestId: id, callId: (args as any).callId, kind: (args as any).kind, sourceId: (args as any).sourceId } : undefined;
      this.pending.set(id, { resolve, reject, cleanup, videoSendScope });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        socket.send(JSON.stringify({ type: 'request', id, op, args }), error => {
          if (error) fail(new RtcError('BRIDGE_DISCONNECTED', '桥接发送失败，操作结果未知。'));
        });
      } catch { fail(new RtcError('BRIDGE_DISCONNECTED', '桥接发送失败，操作结果未知。')); }
    });
  }
  private remote(id: string) {
    const call = this.snapshots.get(id), remote = this.remoteIds.get(id);
    if (!remote || !id.startsWith(`${this.id}:${this.epoch}:`) || !call || terminalStates.has(call.state)) throw new RtcError('CALL_NOT_FOUND', '此桌面通话已结束或来自旧连接');
    return remote;
  }
  async dial(request: CallRequest, signal?: AbortSignal) {
    const epoch = this.epoch;
    const c = await this.request('dial', request, signal);
    if (epoch !== this.epoch || !this.verified || !this.updateCall(c)) throw new RtcError('RESULT_UNKNOWN', '拨号回复无法对应当前连接；请检查实际通话');
    return this.snapshots.get(this.localId(c.id))!;
  }
  async accept(id: string, signal?: AbortSignal) { await this.request('accept', { callId: this.remote(id) }, signal); }
  async reject(id: string, signal?: AbortSignal) { await this.request('reject', { callId: this.remote(id) }, signal); }
  async hangup(id: string, signal?: AbortSignal) { await this.request('hangup', { callId: this.remote(id) }, signal); }
  async setMuted(id: string, muted: boolean) { await this.request('mute', { callId: this.remote(id), muted }); }
  async writeAudio(frame: AudioFrame, playbackId: string): Promise<PlaybackReceipt> {
    if (mediaTransitionBlocksAudio(this.snapshots.get(frame.callId))) throw new RtcError('MEDIA_TRANSITION', '媒体渠道正在切换或切换失败，暂不能发送音频。');
    const receipt = await this.request('audio.write', { frame: { ...frame, callId: this.remote(frame.callId), data: Buffer.from(frame.data).toString('base64') }, playbackId });
    return { ...receipt, callId: frame.callId };
  }
  async clearAudio(id: string) { await this.request('audio.clear', { callId: this.remote(id) }); }
  private parseVideoState(id: string, remote: string, raw: any): VideoState {
    if (!raw || typeof raw.supported !== 'boolean' || raw.sessionId !== null && raw.sessionId !== remote || !Array.isArray(raw.tracks) || raw.tracks.length > 64) throw new RtcError('INVALID_VIDEO', '视频状态不属于当前通话。');
    const tracks: VideoTrack[] = raw.tracks.map((track: any) => {
      if (!track || typeof track.id !== 'string' || !track.id || track.id.length > 512 || typeof track.uid !== 'string' || !track.uid || track.uid.length > 160 ||
        !['camera', 'screen'].includes(track.kind) || ![true, false, null].includes(track.available) || typeof track.subscribed !== 'boolean' || typeof track.hasFrame !== 'boolean') throw new RtcError('INVALID_VIDEO', '后端返回了无效视频轨道。');
      return { trackId: track.id, participantId: track.uid, kind: track.kind, available: track.available, subscribed: track.subscribed, hasFrame: track.hasFrame,
        ...(Number.isInteger(track.width) && track.width > 0 && track.width <= 8192 ? { width: track.width } : {}),
        ...(Number.isInteger(track.height) && track.height > 0 && track.height <= 8192 ? { height: track.height } : {}),
        firstFrameAt: Number.isFinite(track.firstFrameAt) ? track.firstFrameAt : null,
        decodedFrameAt: Number.isFinite(track.decodedFrameAt) ? track.decodedFrameAt : null };
    });
    if (new Set(tracks.map(track => track.trackId)).size !== tracks.length || raw.sessionId === null && tracks.some(track => track.subscribed)) throw new RtcError('INVALID_VIDEO', '视频轨道或会话标识无效。');
    const sending: VideoState['sending'] = {};
    for (const kind of ['camera', 'screen'] as const) {
      const item = raw.sending?.[kind]; if (item === undefined) continue;
      if (!item || typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 2048 || !['starting','sending','stopping','failed'].includes(item.state)) throw new RtcError('INVALID_VIDEO', '后端返回了无效视频发送状态。');
      if (item.framing !== undefined && !['full', 'portrait-safe'].includes(item.framing)) throw new RtcError('INVALID_VIDEO', '后端返回了无效视频画幅。');
      sending[kind] = { sourceId: item.sourceId, state: item.state,
        ...(item.framing === undefined ? {} : { framing: item.framing }),
        ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}), ...(typeof item.evidence === 'string' ? { evidence: item.evidence.slice(0, 500) } : {}) };
    }
    return { supported: raw.supported, callId: raw.sessionId === null ? null : id, tracks, sending,
      ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError.slice(0, 500) } : {}) };
  }
  async videoState(id: string) { const remote = this.remote(id); return this.parseVideoState(id, remote, await this.request('video.state', { callId: remote })); }
  async videoSources(id: string): Promise<VideoSource[]> {
    return this.parseVideoSources(await this.request('video.sources', { callId: this.remote(id) }));
  }
  async availableVideoSources(): Promise<VideoSource[]> {
    const epoch = this.epoch, raw = await this.request('video.sources');
    if (epoch !== this.epoch || !this.verified) throw new RtcError('STALE_CONNECTION', '枚举视频来源期间连接已改变。');
    return this.parseVideoSources(raw);
  }
  private parseVideoSources(raw: any): VideoSource[] {
    if (!Array.isArray(raw) || raw.length > 256 || raw.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 2048 || !['camera','screen'].includes(item.kind) || typeof item.name !== 'string' || item.name.length > 512 || item.sourceType !== undefined && !['device','window','display','frames','generated'].includes(item.sourceType) || item.channels !== undefined && (!Array.isArray(item.channels) || !item.channels.length || item.channels.length > 2 || item.channels.some((kind: unknown) => !['camera','screen'].includes(String(kind))) || !item.channels.includes(item.kind)))) throw new RtcError('INVALID_VIDEO', '后端返回了无效视频来源。');
    return raw.map((item: any) => ({ id: item.id, kind: item.kind, name: item.name, ...(item.sourceType ? { sourceType: item.sourceType } : {}), ...(item.channels ? { channels: [...item.channels] } : {}) }));
  }
  async cancelVideoTransition(id: string): Promise<void> {
    const remote = this.remote(id), targetRequestId = this.videoTransitions.get(remote) ?? this.snapshots.get(id)?.mediaTransition?.requestId;
    if (targetRequestId) await this.request('video.cancel', { callId: remote, targetRequestId });
  }
  async subscribeVideo(id: string, request: VideoSubscribeRequest): Promise<VideoTrack> {
    const remote = this.remote(id), epoch = this.epoch;
    const state = this.parseVideoState(id, remote, await this.request('video.subscribe', { callId: remote, ...request }));
    if (epoch !== this.epoch || !this.verified || this.snapshots.get(id)?.state !== 'connected') throw new RtcError('STALE_CALL', '视频订阅期间连接已改变。');
    const track = state.tracks.find(track => track.participantId === request.participantId && track.kind === request.kind && track.subscribed);
    if (state.callId !== id || !track) throw new RtcError('INVALID_VIDEO', '后端没有确认请求的视频订阅。');
    if (!this.videoTracks.has(id)) this.videoTracks.set(id, new Map()); this.videoTracks.get(id)!.set(track.trackId, track); return track;
  }
  async unsubscribeVideo(id: string, trackId: string) { this.videoTracks.get(id)?.delete(trackId); await this.request('video.unsubscribe', { callId: this.remote(id), trackId }); }
  async sendVideo(id: string, request: VideoSendRequest) {
    const remote = this.remote(id), epoch = this.epoch;
    try { return this.parseVideoState(id, remote, await this.request('video.send', { callId: remote, ...request })); }
    catch (error) {
      const failure = error as Error & { videoSendFailure?: VideoSendFailure };
      const proof = readVideoSendFailure(failure.videoSendFailure, { callId: remote, kind: request.kind, sourceId: request.sourceId });
      delete failure.videoSendFailure;
      if (proof && this.verified && this.epoch === epoch) failure.videoSendFailure = { ...proof, callId: id };
      throw failure;
    }
  }
  async stopVideo(id: string, kind: VideoKind) { const remote = this.remote(id); return this.parseVideoState(id, remote, await this.request('video.stop', { callId: remote, kind })); }
  async writeVideo(frame: VideoWriteFrame): Promise<VideoWriteReceipt> {
    validateVideoWrite(frame); const remote = this.remote(frame.callId), epoch = this.epoch;
    const result = await this.request('video.write', { ...frame, callId: remote, data: Buffer.from(frame.data).toString('base64') });
    if (!this.verified || epoch !== this.epoch || this.snapshots.get(frame.callId)?.state !== 'connected') throw new RtcError('STALE_CALL', '视频写入期间连接已改变。');
    if (result?.callId !== remote) throw new RtcError('INVALID_VIDEO', '视频回执来自另一通话。');
    const receipt: VideoWriteReceipt = { callId: frame.callId, kind: result.kind, sequence: result.sequence, state: result.state, evidence: result.evidence,
      ...(result.acceptedBytes === undefined ? {} : { acceptedBytes: result.acceptedBytes }), ...(typeof result.error === 'string' ? { error: result.error.slice(0, 500) } : {}) };
    validateVideoWriteReceipt(receipt, frame); return receipt;
  }
  async clearVideo(id: string) {
    this.videoTracks.delete(id);
    const remote = this.remoteIds.get(id);
    if (remote && id.startsWith(`${this.id}:${this.epoch}:`) && this.verified) await this.request('video.clear', { callId: remote });
  }
  async channels() { return this.request('channels'); }
  async audioRoutes() { return this.request('audio.routes'); }
  async configureAudio(inputDevice: string, outputDevice: string) { return this.request('audio.configure', { inputDevice, outputDevice }); }
  async devices() { return this.request('devices'); }
  async diagnostics() { if (this.socket?.readyState === WebSocket.OPEN) { try { await this.request('diagnostics'); } catch {} } return this.notices.length ? structuredClone(this.notices) : [{ id: 'transport', level: 'warning' as const, message: '等待桌面桥接状态' }]; }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; clearTimeout(this.retry); this.retry = undefined;
    this.disconnect('桌面桥接已停止');
    const socket = this.socket;
    if (socket) {
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, 'plugin stopped');
      const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
    }
  }
}

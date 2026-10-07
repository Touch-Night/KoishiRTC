import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Account, AudioFrame, CallProvider, CallRequest, CallSnapshot, Capability, Diagnostic, PlaybackReceipt, ProviderEvent, VideoFrame, VideoKind, VideoTrack, VideoState, VideoSource, VideoSubscribeRequest, VideoSendRequest, VideoWriteFrame, VideoWriteReceipt } from './types.js';
import { terminalStates, mediaTransitionBlocksAudio, readVideoSendFailure } from './types.js';
export * from './types.js';

export class RtcError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RtcError'; }
}
export function validateAudio(frame: AudioFrame): void {
  if (!frame || frame.encoding !== 'pcm_s16le' || ![8000, 16000, 24000, 32000, 44100, 48000].includes(frame.sampleRate)
    || ![1, 2].includes(frame.channels) || !(frame.data instanceof Uint8Array) || !frame.data.byteLength
    || frame.data.byteLength % (2 * frame.channels) || frame.data.byteLength > frame.sampleRate * frame.channels * 2
    || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !Number.isFinite(frame.timestamp)) {
    throw new RtcError('INVALID_AUDIO', '需要最多一秒、帧对齐的 PCM S16LE 音频和有效时间戳。');
  }
}
interface Lease { id: string; owner: string; releasing?: boolean }
interface Observer { push(frame: AudioFrame): void; close(error?: Error): void }
interface VideoObserver { push(frame: VideoFrame): void; close(error?: Error): void }
interface VideoSubscription { lease: string; track: VideoTrack; sequence: number; observers: Set<VideoObserver> }
export function validateVideo(frame: VideoFrame): void {
  if (!frame || typeof frame.callId !== 'string' || !frame.callId || typeof frame.trackId !== 'string' || !frame.trackId || frame.trackId.length > 512 ||
    typeof frame.participantId !== 'string' || !frame.participantId || frame.participantId.length > 160 || !['camera', 'screen'].includes(frame.kind) ||
    frame.encoding !== 'jpeg' || !['native-first-frame-and-render-capture', 'native-decoded-size-change-and-render-capture', 'ntgcalls-decoded-frame-and-jpeg-encode', 'livekit-decoded-frame-and-jpeg-encode'].includes(frame.evidence) ||
    !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 8192 || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 8192 ||
    !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 ||
    !(frame.data instanceof Uint8Array) || frame.data.length < 4 || frame.data.length > 256 * 1024 ||
    frame.data[0] !== 0xff || frame.data[1] !== 0xd8 || frame.data.at(-2) !== 0xff || frame.data.at(-1) !== 0xd9) {
    throw new RtcError('INVALID_VIDEO', '需要有效成员标识、时间戳和最多 256 KiB 的 JPEG 视频帧。');
  }
}
export function validateVideoWrite(frame: VideoWriteFrame): void {
  // Outbound frames have no remote participant/track identity or receive evidence.
  validateVideo({ ...frame, trackId: 'outbound', participantId: 'local', evidence: 'native-first-frame-and-render-capture' });
  if (frame.width > 4096 || frame.height > 4096 || frame.width * frame.height > 2073600) throw new RtcError('INVALID_VIDEO', '发送视频最多 2073600 像素且每边不超过 4096。');
}
export function validateVideoWriteReceipt(receipt: VideoWriteReceipt, frame: VideoWriteFrame): void {
  if (!receipt || receipt.callId !== frame.callId || receipt.kind !== frame.kind || receipt.sequence !== frame.sequence ||
    !['accepted', 'rendered', 'submitted', 'dropped', 'failed'].includes(receipt.state) || typeof receipt.evidence !== 'string' || !receipt.evidence || receipt.evidence.length > 500 ||
    receipt.acceptedBytes !== undefined && (!Number.isSafeInteger(receipt.acceptedBytes) || receipt.acceptedBytes < 0 || receipt.acceptedBytes > frame.data.length)) throw new RtcError('INVALID_VIDEO', '视频写入回执与提交的帧不一致。');
}
interface VideoWriteJob { frame: VideoWriteFrame; resolve: (receipt: VideoWriteReceipt) => void; reject: (error: unknown) => void }
interface VideoOutput { sourceId: string; framing: VideoSendRequest['framing']; lease: string; sequence: number; closed: boolean; pending?: VideoWriteJob; running?: Promise<void> }
interface InitialVideo { lease: string; provider: CallProvider; request: VideoSendRequest; cancelled: boolean; started: boolean; timer?: ReturnType<typeof setTimeout>; detach(): void }
function validateInitialVideo(request: CallRequest): void {
  if (request.initialVideo === undefined) return;
  if (!Array.isArray(request.initialVideo) || request.initialVideo.length < 1 || request.initialVideo.length > 2 ||
    new Set(request.initialVideo.map(item => item?.kind)).size !== request.initialVideo.length || request.initialVideo.some(item =>
      !item || !['camera', 'screen'].includes(item.kind) || typeof item.sourceId !== 'string' || !item.sourceId.trim() || item.sourceId.length > 2048 || item.sourceId.includes('\0') ||
      item.framing !== undefined && (!['full', 'portrait-safe'].includes(item.framing) || item.kind !== 'camera' || item.sourceId !== 'external-frames'))) {
    throw new RtcError('INVALID_SOURCE', '初始视频需要最多两个不重复渠道及明确来源，画幅仅适用于 external-frames 摄像头。');
  }
}
const clone = <T>(value: T): T => structuredClone(value);

/** Platform-independent coordinator. Only providers may confirm connection or delivery. */
export class RtcManager extends EventEmitter {
  private providers = new Map<string, CallProvider>();
  private snapshots = new Map<string, CallSnapshot>();
  private leases = new Map<string, Lease>();
  private observers = new Map<string, Set<Observer>>();
  private handlers = new Map<string, (event: ProviderEvent) => void>();
  private tails = new Map<string, Promise<unknown>>();
  private queued = new Map<string, number>();
  private inputSequences = new Map<string, number>();
  private videoSubscriptions = new Map<string, Map<string, VideoSubscription>>();
  private videoDirty = new Set<string>();
  private videoOutputUnknown = new Set<string>();
  private videoOutputs = new Map<string, Map<VideoKind, VideoOutput>>();
  private videoDrains = new Map<string, Set<Promise<void>>>();
  private initialVideos = new Map<string, Map<VideoKind, InitialVideo>>();
  private disposed = false;
  private historyLimit: number;
  constructor(options: { historyLimit?: number } = {}) { super(); this.historyLimit = options.historyLimit ?? 100; if (!Number.isInteger(this.historyLimit) || this.historyLimit < 0 || this.historyLimit > 1000) throw new RtcError('INVALID_CONFIG', '通话历史数量必须为 0–1000。'); }

  async register(provider: CallProvider): Promise<() => Promise<void>> {
    if (this.disposed) throw new RtcError('DISPOSED', '通话服务已停止。');
    if (!provider.id || this.providers.has(provider.id)) throw new RtcError('DUPLICATE_PROVIDER', '通话后端标识重复。');
    this.providers.set(provider.id, provider);
    const handler = (event: ProviderEvent) => this.receive(provider, event);
    this.handlers.set(provider.id, handler);
    provider.events.on('event', handler);
    try {
      await provider.start();
      if (this.disposed || this.providers.get(provider.id) !== provider) throw new RtcError('DISPOSED', '通话后端注册已取消。');
      for (const call of provider.calls()) this.receive(provider, { type: 'call', call });
    } catch (error) {
      provider.events.off('event', handler);
      if (this.providers.get(provider.id) === provider) {
        this.handlers.delete(provider.id); this.providers.delete(provider.id);
        for (const call of [...this.snapshots.values()]) if (call.providerId === provider.id && !terminalStates.has(call.state)) this.update({ ...call, state: 'failed', error: '通话后端启动失败', updatedAt: Date.now() });
      }
      await provider.stop().catch(() => {}); throw error;
    }
    this.emit('availability');
    return () => this.providers.get(provider.id) === provider ? this.unregister(provider.id) : Promise.resolve();
  }
  async unregister(id: string): Promise<void> {
    const provider = this.providers.get(id); if (!provider) return;
    const videoCalls = [...this.videoDirty].filter(callId => this.snapshots.get(callId)?.providerId === id);
    this.providers.delete(id);
    const handler = this.handlers.get(id); if (handler) provider.events.off('event', handler);
    this.handlers.delete(id);
    // Revoke ownership/readers immediately, before a slow provider shutdown. A
    // replacement provider with the same id must not be failed by this cleanup.
    for (const call of [...this.snapshots.values()]) if (call.providerId === id && !terminalStates.has(call.state)) {
      this.update({ ...call, state: 'failed', error: '通话后端已停止', updatedAt: Date.now() });
    }
    try { await Promise.allSettled(videoCalls.map(callId => this.videoSerial(id, () => this.clearProviderVideo(callId, provider), true))); await provider.stop(); } finally { for (const callId of videoCalls) this.videoDirty.delete(callId); this.emit('availability'); }
  }

  listProviders() {
    return [...this.providers.values()].map(p => ({ id: p.id, account: clone(p.account), capabilities: clone(p.capabilities()), audioFormat: clone(p.audioFormat) }));
  }
  listCalls(): CallSnapshot[] { return [...this.snapshots.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone); }
  async availableVideoSources(providerId: string): Promise<VideoSource[]> {
    const provider = this.provider(providerId);
    if (!provider.availableVideoSources) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端不提供拨号前的视频来源枚举。');
    const sources = await provider.availableVideoSources();
    if (this.disposed || this.providers.get(providerId) !== provider) throw new RtcError('PROVIDER_OFFLINE', '枚举期间通话后端已停止。');
    return clone(sources);
  }
  getCall(id: string): CallSnapshot {
    const call = this.snapshots.get(id); if (!call) throw new RtcError('CALL_NOT_FOUND', '找不到这次通话。'); return clone(call);
  }
  async diagnostics(providerId?: string): Promise<Diagnostic[]> {
    const list = providerId ? [this.provider(providerId)] : [...this.providers.values()];
    const result = await Promise.all(list.map(async p => {
      try { return (await p.diagnostics()).map(d => ({ ...d, id: `${p.id}:${d.id}` })); }
      catch (error) { return [{ id: `${p.id}:connection`, level: 'error' as const, message: String(error) }]; }
    }));
    return result.flat();
  }
  controller(owner: string): RtcController {
    if (this.disposed) throw new RtcError('DISPOSED', '通话服务已停止。');
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 128) throw new RtcError('INVALID_OWNER', '控制者名称无效。');
    return new RtcController(this, owner);
  }
  private provider(id: string): CallProvider {
    const provider = this.providers.get(id); if (!provider) throw new RtcError('PROVIDER_OFFLINE', '通话后端未连接。'); return provider;
  }
  private requireCapability(provider: CallProvider, capability: Capability) {
    const status = provider.capabilities()[capability];
    if (!status?.supported) throw new RtcError('CAPABILITY_UNAVAILABLE', status?.reason || `后端不支持 ${capability}。`);
  }
  private active(id: string): CallSnapshot {
    const call = this.getCall(id); if (terminalStates.has(call.state)) throw new RtcError('CALL_ENDED', '这次通话已经结束。'); return call;
  }
  private owned(id: string, lease: string): CallSnapshot {
    const call = this.active(id); if (this.leases.get(id)?.id !== lease || this.leases.get(id)?.releasing) throw new RtcError('NOT_CONTROLLER', '当前插件未持有通话控制权。'); return call;
  }
  assertControl(id: string, lease: string): void { this.owned(id, lease); }
  claim(id: string, owner: string): string {
    const call = this.active(id);
    if (this.leases.has(id)) throw new RtcError('CALL_BUSY', `通话正由 ${this.leases.get(id)!.owner} 控制。`);
    const lease = randomUUID(); this.leases.set(id, { id: lease, owner });
    this.update({ ...call, owner }); return lease;
  }
  async release(id: string, lease: string): Promise<void> {
    const held = this.leases.get(id);
    if (held?.id !== lease || held.releasing) return;
    this.interruptVideoTransition(id);
    this.cancelInitialVideo(id);
    held.releasing = true;
    this.closeVideoReaders(id); this.closeVideoOutputs(id);
    const call = this.snapshots.get(id);
    try {
      if (call && !terminalStates.has(call.state)) {
        const results = await Promise.allSettled([
          this.serial(call.providerId, async () => {
            const current = this.snapshots.get(id);
            if (current && !terminalStates.has(current.state)) await this.provider(current.providerId).clearAudio(id);
          }, true),
          this.videoSerial(call.providerId, async () => {
            const current = this.snapshots.get(id), provider = current && this.providers.get(current.providerId);
            if (provider) await this.clearProviderVideo(id, provider);
          }, true),
        ]);
        const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
      }
    } finally {
      if (this.leases.get(id)?.id === lease) {
        this.leases.delete(id); const current = this.snapshots.get(id);
        if (current) this.update({ ...current, owner: undefined });
      }
    }
  }
  private async serial<T>(providerId: string, task: () => Promise<T>, cleanup = false): Promise<T> {
    const count = this.queued.get(providerId) ?? 0;
    if (!cleanup && count >= 128) throw new RtcError('BACKPRESSURE', '通话操作队列已满。');
    this.queued.set(providerId, count + 1);
    const previous = this.tails.get(providerId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task); this.tails.set(providerId, next);
    try { return await next; } finally {
      if (this.tails.get(providerId) === next) this.tails.delete(providerId);
      const remaining = (this.queued.get(providerId) ?? 1) - 1;
      if (remaining) this.queued.set(providerId, remaining); else this.queued.delete(providerId);
    }
  }
  private videoSerial<T>(providerId: string, task: () => Promise<T>, cleanup = false): Promise<T> {
    return this.serial(`${providerId}\0video`, task, cleanup);
  }
  async originate(providerId: string, request: CallRequest, owner: string, signal?: AbortSignal): Promise<{ call: CallSnapshot; lease: string }> {
    if (!request || typeof request.targetId !== 'string' || !request.targetId.trim() || request.targetId.length > 512 || !['direct', 'group'].includes(request.kind)) throw new RtcError('INVALID_TARGET', '请选择有效的通话对象。');
    if (request.media !== undefined && !['audio', 'video', 'screen'].includes(request.media) || ['video', 'screen'].includes(request.media ?? '') && request.kind !== 'direct') throw new RtcError('INVALID_TARGET', '视频或屏幕共享邀请仅适用于明确发起的私聊通话，媒体类型必须为 audio、video 或 screen。');
    if (request.groupMode !== undefined && !['join', 'create'].includes(request.groupMode) ||
      request.kind !== 'group' && (request.groupMode !== undefined || request.inviteeIds !== undefined) ||
      request.inviteeIds !== undefined && (!Array.isArray(request.inviteeIds) || request.inviteeIds.length > 16 || request.inviteeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 160)) ||
      request.inviteeIds?.length && request.groupMode !== 'create') throw new RtcError('INVALID_TARGET', '邀请名单仅适用于主动发起群通话。');
    validateInitialVideo(request);
    request = clone(request);
    return this.serial(providerId, async () => {
      signal?.throwIfAborted();
      const provider = this.provider(providerId); this.requireCapability(provider, request.kind === 'group' ? request.groupMode === 'create' ? 'startGroup' : 'joinGroup' : request.media === 'screen' ? 'dialScreen' : 'dial');
      if ([...this.snapshots.values()].some(c => c.providerId === providerId && !terminalStates.has(c.state))) throw new RtcError('ACCOUNT_BUSY', '此账号已有未结束的通话。');
      // Initial media is owned by the manager's lease, never an autonomous
      // provider instruction which could survive the calling controller.
      const { initialVideo: _initialVideo, ...invitation } = request;
      const call = await provider.dial(invitation, signal);
      if (this.providers.get(providerId) !== provider) throw new RtcError('PROVIDER_OFFLINE', '拨号期间通话后端已停止；请检查实际通话。');
      this.receive(provider, { type: 'call', call });
      return { call: this.getCall(call.id), lease: this.claim(call.id, owner) };
    });
  }
  async control(id: string, lease: string, action: 'accept' | 'reject' | 'hangup', signal?: AbortSignal): Promise<void> {
    const call = this.owned(id, lease);
    if (action !== 'accept') { this.interruptVideoTransition(id); this.cancelInitialVideo(id); }
    await this.serial(call.providerId, async () => {
      signal?.throwIfAborted(); const current = this.owned(id, lease), provider = this.provider(current.providerId);
      const cap = action === 'hangup' && current.kind === 'group' ? 'leaveGroup' : action;
      this.requireCapability(provider, cap);
      if ((action === 'accept' || action === 'reject') && current.state !== 'ringing') throw new RtcError('INVALID_STATE', '只有尚未接听的来电可以执行此操作。');
      await provider[action](id, signal);
    });
  }
  async mute(id: string, lease: string, value: boolean): Promise<void> {
    if (typeof value !== 'boolean') throw new RtcError('INVALID_REQUEST', '静音状态必须为布尔值。');
    const call = this.owned(id, lease);
    await this.serial(call.providerId, async () => {
      const current = this.owned(id, lease), provider = this.provider(current.providerId);
      this.requireCapability(provider, 'mute'); await provider.setMuted(id, value);
    });
  }
  async write(id: string, lease: string, frame: Omit<AudioFrame, 'callId'>, playbackId: string = randomUUID()): Promise<PlaybackReceipt> {
    const call = this.owned(id, lease);
    if (typeof playbackId !== 'string' || !playbackId || playbackId.length > 160) throw new RtcError('INVALID_AUDIO', '播放标识无效。');
    const audio = { ...frame, callId: id }; validateAudio(audio);
    // Snapshot caller-owned bytes before waiting behind another operation.
    audio.data = Uint8Array.from(audio.data);
    return this.serial(call.providerId, async () => {
      const current = this.owned(id, lease), provider = this.provider(current.providerId);
      if (mediaTransitionBlocksAudio(current)) throw new RtcError('MEDIA_TRANSITION', '媒体渠道正在切换或切换失败，暂不能发送音频。');
      if (current.state !== 'connected') throw new RtcError('NOT_CONNECTED', '通话尚未实际接通。');
      if (current.muted) throw new RtcError('MUTED', '麦克风已静音。');
      this.requireCapability(provider, 'sendAudio');
      return provider.writeAudio(audio, playbackId);
    });
  }
  async clear(id: string, lease: string): Promise<void> {
    const call = this.owned(id, lease);
    await this.serial(call.providerId, async () => {
      const current = this.owned(id, lease); await this.provider(current.providerId).clearAudio(id);
    });
  }

  private connectedVideo(id: string, lease: string, capability?: Capability) {
    const call = this.owned(id, lease), provider = this.provider(call.providerId);
    if (call.state !== 'connected') throw new RtcError('NOT_CONNECTED', '视频需要已实际接通的通话。');
    if (capability) this.requireCapability(provider, capability);
    return { call, provider };
  }
  /** Armed only after RtcController has retained the returned dial lease. */
  armInitialVideo(id: string, lease: string, requests: VideoSendRequest[], signal?: AbortSignal): void {
    const call = this.owned(id, lease), provider = this.provider(call.providerId);
    if (this.disposed || signal?.aborted) return;
    validateInitialVideo({ kind: call.kind, targetId: call.targetId, initialVideo: requests });
    this.cancelInitialVideo(id);
    const plans = new Map<VideoKind, InitialVideo>(); this.initialVideos.set(id, plans);
    for (const request of clone(requests)) {
      const abort = () => this.cancelInitialVideo(id, request.kind);
      const plan: InitialVideo = { lease, provider, request, cancelled: false, started: false, detach: () => signal?.removeEventListener('abort', abort) };
      plans.set(request.kind, plan); signal?.addEventListener('abort', abort, { once: true });
    }
    this.startInitialVideo(id);
  }
  private interruptVideoTransition(id: string): void {
    const call = this.snapshots.get(id), provider = call && this.providers.get(call.providerId);
    if (call && !terminalStates.has(call.state) && provider?.cancelVideoTransition) void provider.cancelVideoTransition(id).catch(error => this.emit('diagnostic', { providerId: provider.id, callId: id, error: `取消媒体切换未确认：${String(error)}` }));
  }
  private cancelInitialVideo(id: string, kind?: VideoKind, interrupt = true): void {
    const plans = this.initialVideos.get(id);
    for (const [channel, plan] of plans ?? []) if (kind === undefined || channel === kind) {
      if (interrupt && channel === 'screen' && plan.started) this.interruptVideoTransition(id);
      plan.cancelled = true; clearTimeout(plan.timer); plan.detach(); plans!.delete(channel);
    }
    if (!plans?.size) this.initialVideos.delete(id);
  }
  private startInitialVideo(id: string): void {
    const call = this.snapshots.get(id), plans = this.initialVideos.get(id);
    if (!call || call.state !== 'connected' || !plans) return;
    for (const [kind, plan] of plans) {
      if (plan.started || plan.cancelled) continue;
      const valid = () => !this.disposed && !plan.cancelled && this.initialVideos.get(id)?.get(kind) === plan &&
        this.providers.get(call.providerId) === plan.provider && this.leases.get(id)?.id === plan.lease && !this.leases.get(id)?.releasing;
      if (!valid()) { this.cancelInitialVideo(id, kind); continue; }
      if (!plan.provider.capabilities()[kind === 'screen' ? 'shareScreen' : 'sendVideo']?.supported) {
        plan.timer ??= setTimeout(() => {
          if (!valid()) return;
          this.cancelInitialVideo(id, kind);
          this.emit('diagnostic', { providerId: call.providerId, callId: id, error: `初始 ${kind} 画面未启动：接通后视频能力仍未就绪。` });
        }, 15000);
        continue;
      }
      plan.started = true; clearTimeout(plan.timer);
      void this.sendVideo(id, plan.lease, plan.request, valid).catch(error => {
        if (!plan.cancelled) this.emit('diagnostic', { providerId: call.providerId, callId: id, error: `初始 ${kind} 画面未启动：${String(error)}` });
      }).finally(() => {
        if (this.initialVideos.get(id)?.get(kind) === plan) this.cancelInitialVideo(id, kind, false);
      });
    }
  }
  private closeVideoReaders(id: string, trackId?: string) {
    const tracks = this.videoSubscriptions.get(id);
    for (const [key, subscription] of tracks ?? []) if (trackId === undefined || key === trackId) {
      for (const observer of [...subscription.observers]) observer.close(); tracks!.delete(key);
    }
    if (!tracks?.size) this.videoSubscriptions.delete(id);
  }
  private async clearProviderVideo(id: string, provider: CallProvider) {
    this.closeVideoOutputs(id); await this.drainVideoWrites(id);
    if (!this.videoDirty.has(id)) return;
    // Remove the marker only after successful cleanup. Unknown outcomes remain
    // retryable by another explicit cleanup, never by re-sending a video start.
    await provider.clearVideo?.(id); this.videoDirty.delete(id);
    for (const kind of ['camera', 'screen']) this.videoOutputUnknown.delete(`${id}\0${kind}`);
  }
  private closeVideoOutputs(id: string, kind?: VideoKind) {
    const outputs = this.videoOutputs.get(id), drains: Promise<void>[] = [];
    for (const [channel, output] of outputs ?? []) if (kind === undefined || channel === kind) {
      output.closed = true; if (output.running) drains.push(output.running);
      if (output.pending) this.dropVideoWrite(output.pending, 'video-source-stopped-before-submit');
      output.pending = undefined; outputs!.delete(channel);
    }
    if (!outputs?.size) this.videoOutputs.delete(id);
    return drains;
  }
  private dropVideoWrite(job: VideoWriteJob, evidence: string) {
    job.resolve({ callId: job.frame.callId, kind: job.frame.kind, sequence: job.frame.sequence, state: 'dropped', acceptedBytes: 0, evidence });
  }
  private async drainVideoWrites(id: string) { await Promise.allSettled([...(this.videoDrains.get(id) ?? [])]); }
  writeVideo(id: string, lease: string, input: Omit<VideoWriteFrame, 'callId'>): Promise<VideoWriteReceipt> {
    const frame: VideoWriteFrame = { callId: id, kind: input?.kind, encoding: input?.encoding, width: input?.width, height: input?.height, sequence: input?.sequence, timestamp: input?.timestamp, data: input?.data }; validateVideoWrite(frame);
    const { provider } = this.connectedVideo(id, lease, frame.kind === 'screen' ? 'shareScreen' : 'sendVideo');
    const output = this.videoOutputs.get(id)?.get(frame.kind);
    if (!output || output.closed || output.lease !== lease || !provider.writeVideo) throw new RtcError('VIDEO_SOURCE_REQUIRED', '请先明确选择并开启支持帧写入的视频来源。');
    if (frame.sequence <= output.sequence) throw new RtcError('VIDEO_SEQUENCE', '视频帧序号必须递增，不能重放旧帧。');
    output.sequence = frame.sequence;
    const copied = { ...frame, data: Uint8Array.from(frame.data) };
    const receipt = new Promise<VideoWriteReceipt>((resolve, reject) => {
      if (output.pending) this.dropVideoWrite(output.pending, 'newer-video-frame-before-submit');
      output.pending = { frame: copied, resolve, reject };
    });
    const pump = () => {
      if (output.running || output.closed || !output.pending) return;
      const run = async () => {
        while (!output.closed && output.pending) {
          const job = output.pending; output.pending = undefined;
          try {
            const current = this.connectedVideo(id, lease, frame.kind === 'screen' ? 'shareScreen' : 'sendVideo');
            if (current.provider !== provider || this.videoOutputs.get(id)?.get(frame.kind) !== output) throw new RtcError('STALE_CALL', '视频来源或通话已改变。');
            const result = await provider.writeVideo!(job.frame);
            this.connectedVideo(id, lease, frame.kind === 'screen' ? 'shareScreen' : 'sendVideo');
            if (output.closed) throw new RtcError('RESULT_UNKNOWN', '写入期间视频来源已停止，请勿重放旧帧。');
            validateVideoWriteReceipt(result, job.frame); job.resolve(clone(result));
          } catch (error) {
            // A missing write receipt is never retried. Require a new explicit
            // source start after uncertain native state, and drop queued frames.
            // An explicit source/framing change has already closed this writer
            // and is waiting for it to drain; do not poison the next output.
            if (!output.closed) { this.videoOutputUnknown.add(`${id}\0${frame.kind}`); this.closeVideoOutputs(id, frame.kind); }
            job.reject(error);
          }
        }
      };
      const running = run(); output.running = running;
      if (!this.videoDrains.has(id)) this.videoDrains.set(id, new Set()); this.videoDrains.get(id)!.add(running);
      void running.finally(() => { output.running = undefined; this.videoDrains.get(id)?.delete(running); if (!this.videoDrains.get(id)?.size) this.videoDrains.delete(id); pump(); });
    };
    pump(); return receipt;
  }
  async videoState(id: string, lease: string): Promise<VideoState> {
    const { provider } = this.connectedVideo(id, lease, 'receiveVideo');
    if (!provider.videoState) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端没有视频状态接口。');
    const state = await provider.videoState(id); this.connectedVideo(id, lease, 'receiveVideo'); return clone(state);
  }
  async videoSources(id: string, lease: string): Promise<VideoSource[]> {
    const { provider } = this.connectedVideo(id, lease);
    if (!provider.capabilities().sendVideo?.supported && !provider.capabilities().shareScreen?.supported || !provider.videoSources) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端未提供视频发送来源。');
    const sources = await provider.videoSources(id); this.connectedVideo(id, lease);
    return clone(sources);
  }
  async subscribeVideo(id: string, lease: string, request: VideoSubscribeRequest): Promise<VideoTrack> {
    if (!request || !['camera', 'screen'].includes(request.kind) || typeof request.participantId !== 'string' || !request.participantId || request.participantId.length > 160) throw new RtcError('INVALID_TRACK', '请选择有效成员及摄像头或屏幕轨道。');
    request = clone(request); const { call } = this.connectedVideo(id, lease, 'receiveVideo');
    return this.videoSerial(call.providerId, async () => {
      const { call: current, provider } = this.connectedVideo(id, lease, 'receiveVideo');
      if (!current.participants.some(member => member.identity === 'platform' && member.id === request.participantId)) throw new RtcError('INVALID_TRACK', '视频成员不属于当前通话。');
      if (!provider.subscribeVideo || !provider.clearVideo || !provider.unsubscribeVideo) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端未提供可清理的视频订阅。');
      const tracks = this.videoSubscriptions.get(id), existing = [...(tracks?.values() ?? [])].find(item => item.track.participantId === request.participantId && item.track.kind === request.kind && item.lease === lease);
      if (existing) return clone(existing.track);
      if ((tracks?.size ?? 0) >= 4) throw new RtcError('VIDEO_LIMIT', '同时最多订阅四路视频。');
      this.videoDirty.add(id);
      const track = await provider.subscribeVideo(id, request);
      try {
        const after = this.connectedVideo(id, lease, 'receiveVideo');
        if (after.provider !== provider || !after.call.participants.some(member => member.identity === 'platform' && member.id === request.participantId)) throw new RtcError('STALE_CALL', '视频订阅期间成员或会话已改变。');
        if (!track || typeof track.trackId !== 'string' || !track.trackId || track.trackId.length > 512 || track.participantId !== request.participantId || track.kind !== request.kind || !track.subscribed || this.videoSubscriptions.get(id)?.has(track.trackId)) throw new RtcError('INVALID_VIDEO', '后端没有返回唯一且匹配的订阅轨道。');
      } catch (error) { if (track?.trackId) await provider.unsubscribeVideo(id, track.trackId).catch(() => {}); throw error; }
      if (!this.videoSubscriptions.has(id)) this.videoSubscriptions.set(id, new Map());
      this.videoSubscriptions.get(id)!.set(track.trackId, { lease, track: clone(track), sequence: -1, observers: new Set() });
      return clone(track);
    });
  }
  async unsubscribeVideo(id: string, lease: string, trackId: string): Promise<void> {
    if (typeof trackId !== 'string' || !trackId || trackId.length > 512) throw new RtcError('INVALID_TRACK', '视频轨道标识无效。');
    const call = this.owned(id, lease), tracked = this.videoSubscriptions.get(id)?.get(trackId);
    if (tracked && tracked.lease !== lease) throw new RtcError('NOT_CONTROLLER', '视频订阅不属于当前控制权。');
    this.closeVideoReaders(id, trackId);
    await this.videoSerial(call.providerId, async () => {
      const current = this.owned(id, lease), provider = this.provider(current.providerId);
      if (!provider.unsubscribeVideo) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端没有视频取消接口。');
      await provider.unsubscribeVideo(id, trackId);
    }, true);
  }
  async sendVideo(id: string, lease: string, request: VideoSendRequest, initialStillCurrent?: () => boolean): Promise<VideoState> {
    if (!request || !['camera', 'screen'].includes(request.kind) || typeof request.sourceId !== 'string' || !request.sourceId || request.sourceId.length > 2048) throw new RtcError('INVALID_SOURCE', '请明确选择视频来源。');
    if (request.framing !== undefined && (!['full', 'portrait-safe'].includes(request.framing) || request.kind !== 'camera' || request.sourceId !== 'external-frames')) throw new RtcError('INVALID_SOURCE', '画幅仅适用于 external-frames 摄像头渠道，必须为 full 或 portrait-safe。');
    request = clone(request); const capability = request.kind === 'screen' ? 'shareScreen' : 'sendVideo';
    const { call } = this.connectedVideo(id, lease, capability);
    if (!initialStillCurrent) this.cancelInitialVideo(id, request.kind);
    const checkInitial = () => { if (initialStillCurrent && !initialStillCurrent()) throw new RtcError('ABORTED', '初始视频发送已取消。'); };
    return this.videoSerial(call.providerId, async () => {
      checkInitial();
      const { provider } = this.connectedVideo(id, lease, capability);
      if (this.videoOutputUnknown.has(`${id}\0${request.kind}`)) throw new RtcError('VIDEO_CLEANUP_REQUIRED', '上次视频启动或帧写入的结果未确认，请先停止此视频渠道。');
      if (!provider.videoSources || !provider.sendVideo || !provider.stopVideo || !provider.clearVideo) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端未提供可清理的视频发送接口。');
      const sources = await provider.videoSources(id); checkInitial(); this.connectedVideo(id, lease, capability);
      const source = sources.find(source => (source.kind === request.kind || source.channels?.includes(request.kind)) && source.id === request.sourceId);
      if (!source) throw new RtcError('INVALID_SOURCE', '视频来源不在当前设备列表中。');
      const framing = request.framing ?? 'full';
      const previous = this.videoOutputs.get(id)?.get(request.kind), reuse = previous && !previous.closed && previous.lease === lease && previous.sourceId === request.sourceId && previous.framing === framing;
      if (!reuse) await Promise.allSettled(this.closeVideoOutputs(id, request.kind)); checkInitial(); this.connectedVideo(id, lease, capability);
      this.videoDirty.add(id);
      let state: VideoState;
      try { state = await provider.sendVideo(id, request); } catch (error) {
        const proof = readVideoSendFailure((error as { videoSendFailure?: unknown })?.videoSendFailure, { callId: id, kind: request.kind, sourceId: request.sourceId });
        // A provider-verified preflight refusal did not start a new sender.
        // Keep a reused writer only when its unchanged source is confirmed;
        // unknown delivery still requires an explicit stop before retrying.
        if (!proof || proof.outcome !== 'unchanged') this.closeVideoOutputs(id, request.kind);
        if (!proof) this.videoOutputUnknown.add(`${id}\0${request.kind}`);
        if (initialStillCurrent && !initialStillCurrent()) await provider.stopVideo(id, request.kind).catch(cleanup => this.emit('diagnostic', { providerId: call.providerId, callId: id, error: `取消初始视频后的清理未确认：${String(cleanup)}` }));
        throw error;
      }
      try { checkInitial(); } catch (error) {
        await provider.stopVideo(id, request.kind).catch(cleanup => {
          this.videoOutputUnknown.add(`${id}\0${request.kind}`);
          this.emit('diagnostic', { providerId: call.providerId, callId: id, error: `取消初始视频后的清理未确认：${String(cleanup)}` });
        }); throw error;
      }
      if ((state.sending[request.kind]?.framing ?? 'full') !== framing) {
        this.closeVideoOutputs(id, request.kind); this.videoOutputUnknown.add(`${id}\0${request.kind}`);
        throw new RtcError('INVALID_VIDEO', '后端未确认请求的视频画幅，请先停止此渠道。');
      }
      try { const current = this.connectedVideo(id, lease, capability); if (current.provider !== provider) throw new RtcError('STALE_CALL', '视频发送后会话已改变。'); }
      catch (error) { await provider.stopVideo(id, request.kind).catch(() => {}); throw error; }
      if (source.sourceType === 'frames' && (!source.channels || source.channels.includes(request.kind)) && provider.writeVideo && state.sending[request.kind]?.sourceId === request.sourceId && state.sending[request.kind]?.state === 'sending') {
        if (!this.videoOutputs.has(id)) this.videoOutputs.set(id, new Map());
        if (!reuse) this.videoOutputs.get(id)!.set(request.kind, { sourceId: request.sourceId, framing, lease, sequence: -1, closed: false });
      }
      return clone(state);
    });
  }
  async stopVideo(id: string, lease: string, kind: VideoKind): Promise<VideoState> {
    if (!['camera', 'screen'].includes(kind)) throw new RtcError('INVALID_SOURCE', '视频来源类型无效。');
    const call = this.owned(id, lease); this.cancelInitialVideo(id, kind);
    if (kind === 'screen') this.interruptVideoTransition(id);
    const draining = this.closeVideoOutputs(id, kind);
    return this.videoSerial(call.providerId, async () => {
      await Promise.allSettled(draining);
      const current = this.owned(id, lease), provider = this.provider(current.providerId);
      if (!provider.stopVideo) throw new RtcError('CAPABILITY_UNAVAILABLE', '后端没有视频停止接口。');
      const state = await provider.stopVideo(id, kind); this.videoOutputUnknown.delete(`${id}\0${kind}`); return clone(state);
    }, true);
  }

  /** One latest JPEG per reader. Slow video consumers drop old frames, never PCM. */
  video(id: string, lease: string, trackId: string, options: { signal?: AbortSignal } = {}): AsyncIterable<VideoFrame> {
    const self = this; let started = false;
    return { [Symbol.asyncIterator]() {
      if (started) throw new RtcError('SINGLE_CONSUMER', '每个视频读取器只能读取一次。'); started = true;
      self.connectedVideo(id, lease, 'receiveVideo');
      const tracked = self.videoSubscriptions.get(id)?.get(trackId);
      if (!tracked || tracked.lease !== lease) throw new RtcError('VIDEO_NOT_SUBSCRIBED', '请先订阅当前成员的视频轨道。');
      if (tracked.observers.size >= 8) throw new RtcError('VIDEO_LIMIT', '同一轨道的视频读取器过多。');
      let latest: VideoFrame | undefined, ended = false, failure: Error | undefined, wake: (() => void) | undefined, reading = false;
      const observer: VideoObserver = {
        push(frame) { if (ended) return; latest = { ...frame, data: Uint8Array.from(frame.data) }; wake?.(); wake = undefined; },
        close(error) { if (ended) return; ended = true; failure = error; latest = undefined; tracked.observers.delete(observer); options.signal?.removeEventListener('abort', abort); wake?.(); wake = undefined; },
      };
      const cancel = async () => { observer.close(); if (!tracked.observers.size && self.videoSubscriptions.get(id)?.get(trackId) === tracked) await self.unsubscribeVideo(id, lease, trackId); };
      const abort = () => { observer.close(new RtcError('ABORTED', '视频订阅已取消。')); void cancel().catch(() => {}); };
      if (options.signal?.aborted) { abort(); throw new RtcError('ABORTED', '视频订阅已取消。'); }
      tracked.observers.add(observer); options.signal?.addEventListener('abort', abort, { once: true });
      const iterator: AsyncIterableIterator<VideoFrame> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (reading) throw new RtcError('READ_PENDING', '上一次视频读取尚未完成。'); reading = true;
          try { while (!ended) { if (latest) { const frame = latest; latest = undefined; return { value: frame, done: false }; } await new Promise<void>(resolve => { wake = resolve; }); } if (failure) throw failure; return { value: undefined, done: true }; }
          finally { reading = false; }
        },
        async return() { await cancel(); return { value: undefined, done: true }; },
        async throw(error) { observer.close(error instanceof Error ? error : new Error(String(error))); await cancel(); throw error; },
      }; return iterator;
    } };
  }

  /** Every subscriber owns a bounded queue; slow consumers cannot exhaust the host. */
  audio(id: string, options: { signal?: AbortSignal; maxBufferMs?: number } = {}): AsyncIterable<AudioFrame> {
    const call = this.active(id); this.requireCapability(this.provider(call.providerId), 'receiveAudio');
    if (call.state === 'ending') throw new RtcError('CALL_ENDING', '通话正在结束，请先完成清理。');
    const requestedMs = options.maxBufferMs ?? 2000;
    if (!Number.isFinite(requestedMs)) throw new RtcError('INVALID_CONFIG', '音频缓冲时长必须是有限数值。');
    const maxMs = Math.min(10000, Math.max(20, requestedMs));
    const queue: AudioFrame[] = []; let queuedMs = 0, ended = false, failure: Error | undefined;
    let wake: (() => void) | undefined;
    const observer: Observer = {
      push: frame => {
        if (ended) return;
        const ms = frame.data.byteLength / (frame.sampleRate * frame.channels * 2) * 1000;
        if (queuedMs + ms > maxMs) { observer.close(new RtcError('AUDIO_OVERFLOW', '音频消费速度过慢，请重新订阅。')); return; }
        queue.push({ ...frame, data: Uint8Array.from(frame.data) }); queuedMs += ms; wake?.(); wake = undefined;
      },
      close: error => { if (ended) return; ended = true; failure = error; queue.length = 0; queuedMs = 0; wake?.(); wake = undefined; cleanup(); },
    };
    const abort = () => observer.close(new RtcError('ABORTED', '音频订阅已取消。'));
    const cleanup = () => { this.observers.get(id)?.delete(observer); if (!this.observers.get(id)?.size) this.observers.delete(id); options.signal?.removeEventListener('abort', abort); };
    let started = false;
    const self = this;
    return { [Symbol.asyncIterator]() {
      if (started) throw new RtcError('SINGLE_CONSUMER', '每个音频订阅只能读取一次。'); started = true;
      if (options.signal?.aborted) throw new RtcError('ABORTED', '音频订阅已取消。');
      if (self.active(id).state === 'ending') throw new RtcError('CALL_ENDING', '通话正在结束，请先完成清理。');
      self.requireCapability(self.provider(call.providerId), 'receiveAudio');
      if (!self.observers.has(id)) self.observers.set(id, new Set()); self.observers.get(id)!.add(observer);
      options.signal?.addEventListener('abort', abort, { once: true });
      let reading = false;
      const iterator: AsyncIterableIterator<AudioFrame> = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (reading) throw new RtcError('READ_PENDING', '上一次音频读取尚未完成。');
          reading = true;
          try {
            while (!ended) {
              const frame = queue.shift();
              if (frame) { queuedMs -= frame.data.byteLength / (frame.sampleRate * frame.channels * 2) * 1000; return { value: frame, done: false }; }
              await new Promise<void>(resolve => { wake = resolve; });
            }
            if (failure) throw failure;
            return { value: undefined, done: true };
          } finally { reading = false; }
        },
        async return() { observer.close(); return { value: undefined, done: true }; },
        async throw(error: unknown) { observer.close(error instanceof Error ? error : new Error(String(error))); throw error; },
      };
      return iterator;
    } };
  }

  private receive(provider: CallProvider, event: ProviderEvent): void {
    if (this.providers.get(provider.id) !== provider) return;
    if (event.type === 'call' && event.call) {
      const call = event.call;
      if (call.providerId !== provider.id || call.account.platform !== provider.account.platform || call.account.selfId !== provider.account.selfId) return;
      const old = this.snapshots.get(call.id);
      if (old && (old.providerId !== provider.id || terminalStates.has(old.state) && !terminalStates.has(call.state))) return;
      this.update({ ...call, owner: this.leases.get(call.id)?.owner });
    } else if (event.type === 'video' && event.video) {
      const frame = event.video, call = this.snapshots.get(frame.callId), tracked = this.videoSubscriptions.get(frame.callId)?.get(frame.trackId), lease = this.leases.get(frame.callId);
      if (!call || call.providerId !== provider.id || call.state !== 'connected' || !provider.capabilities().receiveVideo?.supported ||
        !tracked || lease?.id !== tracked.lease || lease.releasing || tracked.track.participantId !== frame.participantId || tracked.track.kind !== frame.kind ||
        !call.participants.some(member => member.identity === 'platform' && member.id === frame.participantId)) return;
      try { validateVideo(frame); } catch { return; }
      if (frame.sequence <= tracked.sequence) return; tracked.sequence = frame.sequence;
      for (const observer of tracked.observers) observer.push(frame);
    } else if (event.type === 'audio' && event.audio) {
      const frame = event.audio, call = this.snapshots.get(frame.callId);
      if (!call || call.providerId !== provider.id || call.state !== 'connected') return;
      try { validateAudio(frame); } catch { return; }
      const safe = { ...frame };
      if (!provider.capabilities().speakerIdentity.supported || !call.participants.some(p => p.identity === 'platform' && p.id === safe.speakerId)) delete safe.speakerId;
      const key = `${frame.callId}\0${safe.speakerId ?? ''}`;
      if (frame.sequence <= (this.inputSequences.get(key) ?? -1)) return;
      this.inputSequences.set(key, frame.sequence);
      for (const observer of this.observers.get(frame.callId) ?? []) observer.push(safe);
      this.emit('level', { callId: frame.callId, level: pcmLevel(frame.data), timestamp: frame.timestamp });
    } else if (event.type === 'playback' && event.playback) {
      const call = this.snapshots.get(event.playback.callId);
      if (call?.providerId === provider.id) this.emit('playback', clone(event.playback));
    } else if (event.type === 'error') this.emit('diagnostic', { providerId: provider.id, error: event.error });
    else if (event.type === 'availability') {
      const caps = provider.capabilities();
      for (const call of this.snapshots.values()) if (call.providerId === provider.id) for (const kind of ['camera', 'screen'] as const) if (!caps[kind === 'screen' ? 'shareScreen' : 'sendVideo']?.supported) this.closeVideoOutputs(call.id, kind);
      if (!caps.receiveVideo?.supported) for (const call of this.snapshots.values()) if (call.providerId === provider.id) {
        this.closeVideoReaders(call.id);
        if (this.videoDirty.has(call.id) && !caps.sendVideo?.supported && !caps.shareScreen?.supported) void this.videoSerial(provider.id, () => this.clearProviderVideo(call.id, provider), true).catch(error => this.emit('diagnostic', { providerId: provider.id, error: String(error) }));
      }
      for (const call of this.snapshots.values()) if (call.providerId === provider.id) this.startInitialVideo(call.id);
      this.emit('availability');
    }
  }
  private update(call: CallSnapshot): void {
    if (terminalStates.has(call.state) || call.state === 'ending') this.cancelInitialVideo(call.id, undefined, !terminalStates.has(call.state));
    if (terminalStates.has(call.state)) {
      this.leases.delete(call.id); delete call.owner;
    }
    // Cleanup keeps control ownership so hangup can still reach the provider,
    // but no buffered PCM or pending reader should outlive the media session.
    if (terminalStates.has(call.state) || call.state === 'ending') {
      for (const observer of [...(this.observers.get(call.id) ?? [])]) observer.close();
      for (const key of this.inputSequences.keys()) if (key.startsWith(`${call.id}\0`)) this.inputSequences.delete(key);
    }
    const provider = this.providers.get(call.providerId);
    if (call.state !== 'connected') {
      this.closeVideoReaders(call.id); this.closeVideoOutputs(call.id);
      if (provider && this.videoDirty.has(call.id)) void this.videoSerial(call.providerId, () => this.clearProviderVideo(call.id, provider), true).catch(error => this.emit('diagnostic', { providerId: call.providerId, error: String(error) }));
    } else {
      for (const [trackId, tracked] of this.videoSubscriptions.get(call.id) ?? []) if (!call.participants.some(member => member.identity === 'platform' && member.id === tracked.track.participantId)) {
        this.closeVideoReaders(call.id, trackId);
        if (provider?.unsubscribeVideo) void this.videoSerial(call.providerId, () => provider.unsubscribeVideo!(call.id, trackId), true).catch(error => this.emit('diagnostic', { providerId: call.providerId, error: String(error) }));
      }
    }
    this.snapshots.set(call.id, clone(call));
    this.emit('call', clone(call));
    this.startInitialVideo(call.id);
    const ended = [...this.snapshots.values()].filter(c => terminalStates.has(c.state)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const stale of ended.slice(0, Math.max(0, ended.length - this.historyLimit))) this.snapshots.delete(stale.id);
  }
  async dispose(): Promise<void> { this.disposed = true; await Promise.allSettled([...this.providers.keys()].map(id => this.unregister(id))); this.removeAllListeners(); }
}

/** Keep this handle in the consuming plugin's lifecycle and dispose it on unload. */
export class RtcController {
  private leases = new Map<string, string>(); private disposed = false;
  private subscriptions = new Map<string, Set<AbortController>>();
  constructor(private manager: RtcManager, readonly owner: string) {}
  private lease(id: string) { if (this.disposed) throw new RtcError('DISPOSED', '控制者已释放。'); const lease = this.leases.get(id); if (!lease) throw new RtcError('NOT_CONTROLLER', '请先取得通话控制权。'); return lease; }
  claim(id: string) { if (this.disposed) throw new RtcError('DISPOSED', '控制者已释放。'); if (!this.leases.has(id)) this.leases.set(id, this.manager.claim(id, this.owner)); return this.manager.getCall(id); }
  assertControl(id: string): void { this.manager.assertControl(id, this.lease(id)); }
  async dial(providerId: string, request: CallRequest, signal?: AbortSignal) {
    if (this.disposed) throw new RtcError('DISPOSED', '控制者已释放。');
    request = clone(request);
    const result = await this.manager.originate(providerId, request, this.owner, signal);
    if (this.disposed || signal?.aborted) {
      await this.manager.release(result.call.id, result.lease);
      throw new RtcError(this.disposed ? 'DISPOSED' : 'ABORTED', this.disposed ? '控制者已释放。' : '拨号请求已取消。');
    }
    this.leases.set(result.call.id, result.lease);
    if (request.initialVideo) this.manager.armInitialVideo(result.call.id, result.lease, request.initialVideo, signal);
    return this.manager.getCall(result.call.id);
  }
  accept(id: string, signal?: AbortSignal) { return this.manager.control(id, this.lease(id), 'accept', signal); }
  reject(id: string, signal?: AbortSignal) { return this.manager.control(id, this.lease(id), 'reject', signal); }
  hangup(id: string, signal?: AbortSignal) { return this.manager.control(id, this.lease(id), 'hangup', signal); }
  setMuted(id: string, muted: boolean) { return this.manager.mute(id, this.lease(id), muted); }
  writeAudio(id: string, frame: Omit<AudioFrame, 'callId'>, playbackId?: string) { return this.manager.write(id, this.lease(id), frame, playbackId); }
  clearAudio(id: string) { return this.manager.clear(id, this.lease(id)); }
  videoState(id: string) { return this.manager.videoState(id, this.lease(id)); }
  videoSources(id: string) { return this.manager.videoSources(id, this.lease(id)); }
  subscribeVideo(id: string, request: VideoSubscribeRequest) { return this.manager.subscribeVideo(id, this.lease(id), request); }
  unsubscribeVideo(id: string, trackId: string) { return this.manager.unsubscribeVideo(id, this.lease(id), trackId); }
  writeVideo(id: string, frame: Omit<VideoWriteFrame, 'callId'>) { return this.manager.writeVideo(id, this.lease(id), frame); }
  sendVideo(id: string, request: VideoSendRequest) { return this.manager.sendVideo(id, this.lease(id), request); }
  stopVideo(id: string, kind: VideoKind) { return this.manager.stopVideo(id, this.lease(id), kind); }
  video(id: string, trackId: string, options: { signal?: AbortSignal } = {}) { return this.manager.video(id, this.lease(id), trackId, options); }
  audio(id: string, options: { signal?: AbortSignal; maxBufferMs?: number } = {}): AsyncIterable<AudioFrame> {
    const lease = this.lease(id), self = this; let started = false;
    return { [Symbol.asyncIterator]() {
      if (started) throw new RtcError('SINGLE_CONSUMER', '每个音频订阅只能读取一次。'); started = true;
      if (self.lease(id) !== lease) throw new RtcError('NOT_CONTROLLER', '音频订阅的控制权已释放。');
      const cancel = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, cancel.signal]) : cancel.signal;
      const iterator = self.manager.audio(id, { ...options, signal })[Symbol.asyncIterator]();
      if (!self.subscriptions.has(id)) self.subscriptions.set(id, new Set()); self.subscriptions.get(id)!.add(cancel);
      const cleanup = () => { self.subscriptions.get(id)?.delete(cancel); if (!self.subscriptions.get(id)?.size) self.subscriptions.delete(id); };
      return {
        async next() { try { const item = await iterator.next(); if (item.done) cleanup(); return item; } catch (error) { cleanup(); throw error; } },
        async return() { cleanup(); return iterator.return ? iterator.return() : { value: undefined, done: true as const }; },
        async throw(error: unknown) { cleanup(); cancel.abort(); if (iterator.throw) return iterator.throw(error); throw error; },
      };
    } };
  }
  private cancelReaders(id: string) { for (const reader of this.subscriptions.get(id) ?? []) reader.abort(); this.subscriptions.delete(id); }
  async release(id: string) { this.cancelReaders(id); const lease = this.leases.get(id); this.leases.delete(id); if (lease) await this.manager.release(id, lease); }
  async dispose() { this.disposed = true; for (const id of this.subscriptions.keys()) this.cancelReaders(id); await Promise.allSettled([...this.leases].map(([id, lease]) => this.manager.release(id, lease))); this.leases.clear(); }
}
export function pcmLevel(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength); let sum = 0;
  for (let i = 0; i + 1 < data.byteLength; i += 2) { const sample = view.getInt16(i, true) / 32768; sum += sample * sample; }
  return Math.sqrt(sum / Math.max(1, data.byteLength / 2));
}

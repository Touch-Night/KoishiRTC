// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fail = (code, message) => Object.assign(new Error(message), { code });
const sourceType = { camera: 1, screen: 2 };
const key = (uid, kind) => `${uid}:${kind}`;
/** QQ owns decoding. We capture only its dedicated render surface, never a desktop. */
class VideoHost {
  constructor({ send, surface, capture, listWindows = async () => [], testWindow, closeTestWindow = () => {}, captureSource = null, closeCapture = async () => {}, ensurePermission = async () => {}, permissions = () => ({}), outputBackend = null, enabled = false, now = Date.now }) {
    Object.assign(this, { send, surface, capture, listWindows, testWindow, closeTestWindow, captureSource, closeCapture, ensurePermission, permissions, enabled, now });
    this.sessionId = null; this.nativeSceneId = null; this.selfUid = null; this.members = new Set(); this.tracks = new Map();
    this.frameChannels = new Map(); this.outputBackend = outputBackend;
    this.generation = 0; this.sessionVersion = 0; this.sequence = 0; this.layoutVersion = 0; this.captureJob = null;
    this.sending = {}; this.lastError = null; this.pending = new Map(); this.nextId = -2000000; this.sourcesById = new Map(); this.controlTail = Promise.resolve(); this.uncertainCommands = new Set(); this.cleanupError = null;
  }
  require(callId) {
    if (!this.enabled) throw fail('VIDEO_UNAVAILABLE', 'This native build has no audited video bridge');
    if (this.cleanupError) throw fail('VIDEO_CLEANUP_UNKNOWN', this.cleanupError);
    if (!callId || callId !== this.sessionId) throw fail('STALE_CALL', 'Video session does not match the connected call');
  }
  scope() { return { callId: this.sessionId, generation: this.generation }; }
  checkScope(scope) {
    if (scope.generation !== this.generation || scope.callId !== this.sessionId) throw fail('STALE_CALL', 'Video session changed');
    this.require(scope.callId);
  }
  async session({ callId, selfUid, nativeSceneId = null, participants = [] }) {
    if (callId !== null && (typeof callId !== 'string' || callId.length > 160 || typeof selfUid !== 'string' || !Array.isArray(participants) || participants.length > 500 || participants.some(uid => typeof uid !== 'string' || uid.length > 160))) throw fail('INVALID_SESSION', 'Invalid video session');
    if (callId === null) { await this.clear(); return this.state(); }
    // clear invalidates immediately and queues cleanup. Queue the new session
    // after it without awaiting here, so any later clear also cancels this request.
    if (this.sessionId && this.sessionId !== callId) void this.clear().catch(error => { this.lastError = error.message; });
    const version = this.sessionVersion = (this.sessionVersion ?? 0) + 1;
    return this.serial(async () => {
      if (version !== this.sessionVersion) throw fail('STALE_CALL', 'Video session update was superseded');
      this.sessionId = callId; this.nativeSceneId = [1, 2, 3].includes(nativeSceneId) ? nativeSceneId : null; this.selfUid = selfUid; this.members = new Set(participants);
      const scope = this.scope();
      let changed = false;
      for (const [id, track] of this.tracks) if (!this.members.has(track.uid) && track.uid !== selfUid) { this.tracks.delete(id); changed = true; }
      if (changed) await this.refresh(scope);
      this.checkScope(scope);
      if (version !== this.sessionVersion) throw fail('STALE_CALL', 'Video session update was superseded');
      return this.state();
    });
  }
  state() {
    return { permissions: this.permissions(), supported: this.enabled && !this.cleanupError, sendSupported: this.enabled && !this.cleanupError, shareScreenSupported: this.enabled && !this.cleanupError && !!this.testWindow && (!this.sessionId || [2, 3].includes(this.nativeSceneId)), sessionId: this.sessionId, tracks: [...this.tracks.values()].map(({ frame, rect, ...track }) => ({ ...track, hasFrame: !!frame })), sending: { ...this.sending }, cameraRequestedFormat: this.cameraRequestedFormat ?? null, lastError: this.cleanupError || this.lastError };
  }
  handle(message) {
    const v = message?.value;
    let pending = this.pending.get(message?.id);
    if (!pending && message?.id === 0 && Array.isArray(v) && Number.isInteger(v[0]) && v[0] < 0) {
      const matches = [...this.pending.values()].filter(p => p.command === message.cmd);
      if (matches.length === 1) pending = matches[0];
    }
    // Command 47 first acknowledges scheduling, then reports DeviceOpen with the same ID.
    const cameraQueued = message.cmd === 47 && v?.[0] === 0 && v?.[1] === 'Start camera capture success!';
    if (pending && pending.command === message.cmd && Array.isArray(v) && !cameraQueued) {
      this.pending.delete(pending.id); clearTimeout(pending.timer); pending.resolve(v);
    }
    if (!this.enabled || !Array.isArray(v)) return;
    if (message.cmd === 20030 && this.sessionId && v.length === 3 && v.every(Number.isInteger) && v[0] > 0 && v[0] <= 8192 && v[1] > 0 && v[1] <= 8192 && v[2] > 0 && v[2] <= 120) {
      this.cameraRequestedFormat = { width: v[0], height: v[1], fps: v[2] };
    }
    if (message.cmd === 20026 && this.stagePending && Number.isInteger(v[0])) {
      const stage = this.stagePending; this.stagePending = null; clearTimeout(stage.timer);
      if (stage.generation !== this.generation) stage.reject(fail('STALE_CALL', 'Video session changed while publishing'));
      else if ([0, 1, 3].includes(v[0])) stage.resolve();
      else stage.reject(fail('NATIVE_VIDEO_ERROR', `QQ rejected camera publication (${v[0]})`));
    }
    if (message.cmd === 20053 && this.sessionId && ['starting', 'sending'].includes(this.sending.camera?.state)) {
      const current = this.sending.camera, generation = this.generation, scene = this.nativeSceneId;
      current.state = 'failed'; current.error = 'QQ lost the selected camera device'; this.lastError = current.error; this.closeFrames('camera');
      if (this.stagePending) { const stage = this.stagePending; this.stagePending = null; clearTimeout(stage.timer); stage.reject(fail('CAMERA_LOST', current.error)); }
      void this.serial(async () => {
        if (generation === this.generation && this.sending.camera === current) await this.stopNative('camera', scene);
      }).catch(error => { this.cleanupError = error.message; });
      return;
    }
    if (message.cmd === 20004 && v[0] === 0) {
      void this.clear().catch(error => { this.lastError = error.message; }); this.lastError = null; return;
    }
    if ([20025, 20033].includes(message.cmd) && typeof v[0] === 'string' && v[0].length <= 160 && [0, 1, false, true].includes(v[1])) {
      if (!this.sessionId || (v[0] !== this.selfUid && !this.members.has(v[0]))) return;
      const kind = message.cmd === 20025 ? 'camera' : 'screen', id = key(v[0], kind), old = this.tracks.get(id);
      if (this.tracks.size >= 64 && !old) return;
      const track = { ...old, id, uid: v[0], kind, available: !!v[1], subscribed: old?.subscribed ?? false, firstFrameAt: old?.firstFrameAt ?? null };
      if (!track.available) { track.frame = null; track.firstFrameAt = null; track.decodedFrameAt = null; track.frameEvidence = null; }
      this.tracks.set(id, track);
    } else if ([20031, 20049].includes(message.cmd) && typeof v[0] === 'string' && [1, 2].includes(v[1]) && Number.isInteger(v[2]) && Number.isInteger(v[3]) && v[2] > 0 && v[3] > 0 && v[2] <= 8192 && v[3] <= 8192) {
      const kind = v[1] === 1 ? 'camera' : 'screen', id = key(v[0], kind);
      if (!this.sessionId || !this.members.has(v[0]) || v[0] === this.selfUid) return;
      let track = this.tracks.get(id);
      // DAV decodes automatically. Its first-frame callback can precede the
      // human's subscription, and may never repeat. Retain only metadata for
      // this session's authorized peer; pixels still require a subscription.
      if (!track?.subscribed) {
        if (this.nativeSceneId !== 1 || kind !== 'camera') return;
        if (!track) {
          if (this.tracks.size >= 64) return;
          track = { id, uid: v[0], kind, subscribed: false, firstFrameAt: null, frame: null };
          this.tracks.set(id, track);
        }
      }
      const resized = track.width !== v[2] || track.height !== v[3];
      // Both callbacks originate in GLRender::UpdateCallBack after a decoded
      // frame reaches its current UID/source texture. 20031 is emitted only
      // while that native texture's old width is zero; 20049 reports a decoded
      // size/angle change, not an advertised video size or first-frame event.
      Object.assign(track, { available: true, width: v[2], height: v[3],
        firstFrameAt: message.cmd === 20031 ? track.firstFrameAt ?? this.now() : track.firstFrameAt,
        decodedFrameAt: track.decodedFrameAt ?? this.now(),
        frameEvidence: message.cmd === 20031 ? 'native-first-frame-and-render-capture' : track.frameEvidence ?? 'native-decoded-size-change-and-render-capture' });
      if (resized && track.subscribed) {
        const scope = this.scope();
        this.layoutJob = this.serial(() => this.layout(scope)).catch(error => { if (scope.generation === this.generation) this.lastError = error.message; });
      }
    } else if (message.cmd === 20028 && Number.isInteger(v[0]) && v[0] !== 0) {
      this.lastError = `Native remote video subscription failed (${v[0]})`;
      for (const track of this.tracks.values()) if (track.subscribed) { track.firstFrameAt = null; track.decodedFrameAt = null; track.frameEvidence = null; track.frame = null; }
    } else if (message.cmd === 20022) { void this.clear().catch(error => { this.lastError = error.message; }); }
  }
  async subscribe({ callId, uid, kind }) {
    this.require(callId);
    const scope = this.scope();
    return this.serial(async () => {
      this.checkScope(scope);
      if (!['camera', 'screen'].includes(kind) || typeof uid !== 'string' || uid === this.selfUid || !this.members.has(uid)) throw fail('INVALID_TRACK', 'Select a remote participant and camera or screen');
      const id = key(uid, kind), old = this.tracks.get(id);
      if (!old?.subscribed && [...this.tracks.values()].filter(t => t.subscribed).length >= 4) throw fail('VIDEO_LIMIT', 'At most four simultaneous video subscriptions');
      if (old?.subscribed) return this.state();
      if (!old && this.tracks.size >= 64) {
        const evict = [...this.tracks.values()].find(t => !t.subscribed);
        if (!evict) throw fail('VIDEO_LIMIT', 'Too many tracked video sources');
        this.tracks.delete(evict.id);
      }
      if (kind === 'screen' && ![2, 3].includes(this.nativeSceneId)) throw fail('VIDEO_SCENE_UNSUPPORTED', 'Screen video requires a screen-share call or group call');
      const track = { ...old, id, uid, kind, available: old?.available ?? null, subscribed: true, firstFrameAt: old?.firstFrameAt ?? null, frame: null };
      this.tracks.set(id, track);
      try { await this.refresh(scope); } catch (error) { if (this.tracks.get(id) === track) track.subscribed = false; throw error; }
      this.checkScope(scope);
      return this.state();
    });
  }
  async unsubscribe({ callId, trackId }) {
    this.require(callId); const scope = this.scope();
    return this.serial(async () => {
      this.checkScope(scope); const track = this.tracks.get(trackId);
      if (track) { track.subscribed = false; track.frame = null; track.firstFrameAt = null; track.decodedFrameAt = null; track.frameEvidence = null; await this.refresh(scope); }
      this.checkScope(scope);
      return this.state();
    });
  }
  async refresh(scope = this.scope()) {
    this.checkScope(scope);
    const tracks = [...this.tracks.values()].filter(t => t.subscribed);
    this.layoutVersion++;
    if (!tracks.length) {
      if ([2, 3].includes(this.nativeSceneId)) await this.native(34, [], [1]);
      this.checkScope(scope); await this.clearNativeLayout(); this.checkScope(scope); return;
    }
    await this.layout(scope);
    this.checkScope(scope);
    if (this.nativeSceneId === 1) return; // DAV receives the peer camera without the MAV subscription API.
    if (![2, 3].includes(this.nativeSceneId)) throw fail('VIDEO_SCENE_UNSUPPORTED', 'Unknown video call scene');
    await this.native(33, [JSON.stringify({ count: tracks.length, request_list: tracks.map(t => ({ uid: t.uid, sourceType: sourceType[t.kind], terminalType: 0, isNeedToRequest: true, isLocal: false, isBig: true })) })], [1]);
    this.checkScope(scope);
  }
  async layout(scope = this.scope()) {
    this.checkScope(scope);
    const tracks = [...this.tracks.values()].filter(t => t.subscribed);
    if (!tracks.length) return;
    const version = ++this.layoutVersion;
    // Native GL uses a fill rectangle. Match each decoded stream's aspect ratio
    // before supplying that rectangle, so portrait cameras are not center-cropped.
    const width = 640, height = tracks.length > 1 ? 480 : 640, columns = tracks.length > 1 ? 2 : 1, rows = Math.ceil(tracks.length / columns);
    await this.surface(width, height);
    this.checkScope(scope);
    if (version !== this.layoutVersion) throw fail('STALE_VIDEO_LAYOUT', 'Video layout changed while preparing its surface');
    for (let i = 0; i < tracks.length; i++) {
      const slotWidth = width / columns, slotHeight = height / rows;
      const ratio = tracks[i].width && tracks[i].height ? tracks[i].width / tracks[i].height : slotWidth / slotHeight;
      const w = Math.max(1, Math.floor(Math.min(slotWidth, slotHeight * ratio))), h = Math.max(1, Math.floor(w / ratio));
      tracks[i].rect = { x: Math.floor((i % columns) * slotWidth + (slotWidth - w) / 2), y: Math.floor(Math.floor(i / columns) * slotHeight + (slotHeight - h) / 2), width: w, height: h }; tracks[i].frame = null;
    }
    await this.send(54, [tracks.length, tracks.map(t => t.uid), tracks.map(t => sourceType[t.kind]), tracks.map(t => { const r = t.rect; return `${r.x},${r.y},${r.x + r.width},${r.y + r.height}`; }), width, height, 100]);
    this.checkScope(scope);
  }
  async clearNativeLayout() {
    // Command 34 stops MAV receiving but leaves the GL UID/source cache intact.
    // An empty 54 layout removes every TexInfo, including its width and pixels,
    // so another call to the same peer must supply new decoded-frame evidence.
    await this.send(54, [0, [], [], [], 640, 640, 100]);
  }
  async frame({ callId, trackId }) {
    this.require(callId); const scope = this.scope(); await this.layoutJob;
    if (scope.generation !== this.generation || callId !== this.sessionId) return null;
    const track = this.tracks.get(trackId);
    if (!track?.subscribed || !track.decodedFrameAt || track.available === false) return null;
    if (track.frame && this.now() - track.frame.timestamp < 150) return track.frame;
    if (!this.captureJob) {
      const generation = this.generation, layout = this.layoutVersion, selected = [...this.tracks.values()].filter(t => t.subscribed && t.decodedFrameAt && t.available !== false);
      this.captureJob = (async () => {
        const image = await this.capture();
        if (generation !== this.generation || layout !== this.layoutVersion) return;
        for (const current of selected) {
          if (this.tracks.get(current.id) !== current || !current.subscribed || current.available === false) continue;
          const cropped = image.crop(current.rect), bytes = cropped.toJPEG(65), size = cropped.getSize();
          if (!bytes.length || bytes.length > 256 * 1024) continue;
          current.frame = { callId, trackId: current.id, participantId: current.uid, kind: current.kind, encoding: 'jpeg', width: size.width, height: size.height, sequence: this.sequence++, timestamp: this.now(), evidence: current.frameEvidence, data: bytes.toString('base64') };
        }
      })().finally(() => { this.captureJob = null; });
    }
    await this.captureJob;
    if (this.sessionId !== callId || this.tracks.get(trackId) !== track || !track.subscribed || track.available === false) return null;
    return track.frame ?? null;
  }
  async native(command, params, success = [0]) {
    if (!this.enabled) throw fail('VIDEO_UNAVAILABLE', 'Native video is unavailable');
    if (this.uncertainCommands.has(command)) throw fail('VIDEO_RESTART_REQUIRED', `Video command ${command} previously timed out; restart the AV Host before repeating it`);
    const id = this.nextId--;
    const result = await new Promise((resolve, reject) => {
      const entry = { id, command, resolve, reject, timer: setTimeout(() => { this.pending.delete(id); this.uncertainCommands.add(command); reject(fail('NATIVE_TIMEOUT', `Video command ${command} has no native acknowledgement; outcome unknown`)); }, 3000) };
      this.pending.set(id, entry);
      Promise.resolve().then(() => this.send(command, params, id)).catch(error => { this.pending.delete(id); clearTimeout(entry.timer); reject(error); });
    });
    // Audited native branch: the camera-core pointer is null, so stopping is complete.
    if (command === 49 && result[0] === -1 && result[1] === 'No Existing Camera capture') return result;
    if (!Number.isInteger(result[0]) || !success.includes(result[0])) throw fail('NATIVE_VIDEO_ERROR', `Video command ${command} failed (${result[0]}): ${typeof result[1] === 'string' ? result[1].slice(0, 160) : 'unknown response'}`);
    return result;
  }
  serial(work) { const task = this.controlTail.catch(() => {}).then(work); this.controlTail = task; return task; }
  async sources({ callId }) {
    callId ??= this.sessionId;
    this.require(callId);
    return this.serial(async () => {
      this.require(callId); const generation = this.generation;
      const cameras = await this.native(46, [true]);
      let timeout;
      const windows = await Promise.race([this.listWindows().catch(error => { this.lastError = error.message; return []; }), new Promise(resolve => { timeout = setTimeout(() => resolve([]), 2000); })]).finally(() => clearTimeout(timeout)); this.require(callId);
      if (generation !== this.generation) throw fail('STALE_CALL', 'Video session changed');
      const available = new Map();
      if (Array.isArray(cameras[2]) && Array.isArray(cameras[3]) && cameras[2].length === cameras[3].length) {
        for (let i = 0; i < Math.min(64, cameras[2].length); i++) {
          const name = cameras[2][i], device = cameras[3][i];
          if (typeof name !== 'string' || typeof device !== 'string' || !device || device.length > 512) continue;
          const id = `camera:${device}`; available.set(id, { id, name: name.slice(0, 200), kind: 'camera', sourceType: 'device', channels: ['camera'], device });
        }
      }
      for (const window of windows.slice(0, 128)) if (typeof window.id === 'string' && (typeof window.captureId === 'string' && this.captureSource || Number.isSafeInteger(window.handle) && window.handle > 0)) available.set(window.id, { ...window, kind: 'screen', sourceType: window.sourceType === 'display' ? 'display' : 'window', channels: ['screen'] });
      if (this.testWindow) available.set('test-pattern', { id: 'test-pattern', name: '动态测试画面（不捕获桌面）', kind: 'screen', sourceType: 'generated', channels: ['screen'], generated: true });
      const channels = this.outputs().cameraAvailable() ? ['screen', 'camera'] : ['screen'];
      available.set('external-frames', { id: 'external-frames', name: '插件提供的视频帧', kind: 'screen', sourceType: 'frames', channels });
      this.sourcesById = available;
      return [...available.values()].flatMap(({ id, name, kind, sourceType, channels }) => (channels || [kind]).map(channel => ({ id, name, kind: channel, sourceType, channels })));
    });
  }
  async startSend({ callId, kind, sourceId, framing }) {
    this.require(callId);
    if (framing !== undefined && (!['full', 'portrait-safe'].includes(framing) || kind !== 'camera' || sourceId !== 'external-frames')) throw fail('INVALID_SOURCE', 'Framing is only supported for explicitly supplied camera frames');
    return this.serial(async () => {
      this.require(callId);
      if (kind === 'screen' && ![2, 3].includes(this.nativeSceneId)) throw fail('VIDEO_SCENE_UNSUPPORTED', 'Start a private screen-share call or use a group call before sharing a screen');
      const generation = this.generation, scene = this.nativeSceneId, source = this.sourcesById.get(sourceId);
      if (!source || !['camera', 'screen'].includes(kind) || !(source.channels || [source.kind]).includes(kind)) throw fail('INVALID_SOURCE', 'Choose an explicitly enumerated video source');
      if (this.sending[kind]?.state === 'sending' && this.sending[kind].sourceId === sourceId && (this.sending[kind].framing ?? 'full') === (framing ?? 'full')) return this.state();
      this.closeFrames(kind);
      const current = { sourceId, state: 'starting', ...(kind === 'camera' && sourceId === 'external-frames' ? { framing: framing ?? 'full' } : {}) }; this.sending[kind] = current;
      const check = () => { this.require(callId); if (generation !== this.generation) throw fail('STALE_CALL', 'Video session changed'); };
      try {
        await this.ensurePermission(kind); check();
        if (kind === 'camera') {
          // A live camera core ignores a newly supplied device. Always release it first.
          await this.native(49, []); check();
          let device = source.device;
          if (source.sourceType === 'frames') {
            const output = await this.outputs().open(kind, callId, { framing: framing ?? 'full' }); check();
            const cameras = await this.native(46, [true]); check();
            const index = Array.isArray(cameras[3]) ? cameras[3].indexOf(output.nativeDeviceId) : -1;
            if (index < 0) throw fail('VIRTUAL_CAMERA_NOT_FOUND', 'QQ did not enumerate the configured virtual camera after its producer started');
            device = cameras[3][index];
          }
          await this.native(47, [device, true, true]); check();
          await this.native(48, []); check();
          await this.publishCamera(scene); check();
        } else {
          await this.native(36, [1], [1]); check();
          await this.native(45, []); check();
          await this.closeCapture(); check();
          const sourceFailed = error => {
            if (generation !== this.generation || this.sending[kind] !== current) return;
            current.state = 'failed'; current.error = error.message; this.lastError = error.message;
            void this.serial(async () => { if (generation === this.generation && this.sending[kind] === current) await this.stopNative(kind, scene); }).catch(cleanup => { this.cleanupError = cleanup.message; });
          };
          const handle = source.captureId && this.captureSource ? await this.captureSource(source, sourceFailed) : source.sourceType === 'frames' ? (await this.outputs().open(kind, callId)).handle : source.generated ? await this.testWindow() : source.handle; check();
          if (!Number.isSafeInteger(handle) || handle <= 0) throw fail('INVALID_SOURCE', 'No valid native window handle');
          await this.native(44, [false, handle, false]); check();
          await this.native(35, [1], [1]); check();
        }
        if (current.state === 'failed') throw fail('NATIVE_VIDEO_ERROR', current.error);
        Object.assign(current, { state: 'sending', evidence: 'native-send-start-acknowledged' });
        if (source.sourceType === 'frames') this.frameChannels.set(kind, { callId, kind, generation, lastSequence: -1, busy: false, closed: false, pending: null });
      } catch (error) {
        Object.assign(current, { state: 'failed', error: error.message });
        await this.stopNative(kind, scene).catch(cleanup => { this.cleanupError = cleanup.message; }); throw error;
      }
      return this.state();
    });
  }
  async publishCamera(scene) {
    // DAV acknowledges synchronous enqueueing with 0 and does not emit 20026.
    if (scene === 1) { await this.native(30, [], [0]); return; }
    let stage;
    const ready = new Promise((resolve, reject) => {
      stage = { generation: this.generation, resolve, reject, timer: setTimeout(() => {
        if (this.stagePending === stage) this.stagePending = null;
        reject(fail('NATIVE_TIMEOUT', 'QQ did not confirm camera publication'));
      }, 5000) };
      this.stagePending = stage;
    });
    ready.catch(() => {});
    try { await this.native(30, [], [1]); await ready; }
    finally { clearTimeout(stage.timer); if (this.stagePending === stage) this.stagePending = null; }
  }
  async stopNative(kind, nativeSceneId = this.nativeSceneId) {
    this.closeFrames(kind);
    try {
    if (kind === 'camera') { try { await this.native(31, [], nativeSceneId === 1 ? [0] : [1]); } finally { await this.native(49, []); } }
    else { try { await this.native(36, [1], [1]); } finally { try { await this.native(45, []); } finally { this.closeTestWindow(); } } }
    } finally { if (kind === 'screen') await this.closeCapture(); await this.outputBackend?.close(kind); }
  }
  async stopSend({ callId, kind }) {
    this.require(callId); if (!['camera', 'screen'].includes(kind)) throw fail('INVALID_SOURCE', 'Unknown video kind');
    return this.serial(async () => {
      this.require(callId); if (this.sending[kind]) this.sending[kind].state = 'stopping';
      try { await this.stopNative(kind); delete this.sending[kind]; }
      catch (error) { this.sending[kind] = { sourceId: this.sending[kind]?.sourceId || '', state: 'failed', error: error.message }; throw error; }
      return this.state();
    });
  }
  outputs() { return this.outputBackend ??= new (require('./frame-output.cjs').FrameOutputs)(); }
  closeFrames(kind) {
    const channel = this.frameChannels.get(kind); if (!channel) return;
    channel.closed = true; this.frameChannels.delete(kind);
    if (channel.pending) { channel.pending.resolve(this.frameReceipt(channel.pending.frame, 'dropped', 'output-stopped')); channel.pending = null; }
  }
  frameReceipt(frame, state, evidence) { return { callId: frame.callId, kind: frame.kind, sequence: frame.sequence, state, evidence, acceptedBytes: state === 'dropped' ? 0 : Buffer.byteLength(frame.data, 'base64') }; }
  async write(frame) {
    this.require(frame.callId);
    const channel = this.frameChannels.get(frame.kind);
    if (!channel || channel.callId !== frame.callId || channel.closed || this.sending[frame.kind]?.sourceId !== 'external-frames' || this.sending[frame.kind]?.state !== 'sending') throw fail('VIDEO_SOURCE_NOT_WRITABLE', 'Select and start the external frame source on this channel before writing');
    if (frame.encoding !== 'jpeg' || typeof frame.data !== 'string' || frame.data.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !Number.isFinite(frame.timestamp) || frame.timestamp < 0 || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width > 4096 || frame.height > 4096 || frame.width * frame.height > 2073600) throw fail('INVALID_VIDEO', 'Invalid JPEG video frame (maximum 1080p / 256 KiB)');
    const data = Buffer.from(frame.data, 'base64');
    if (data.length > 262144 || data.length < 4 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) throw fail('INVALID_VIDEO', 'Invalid JPEG video frame');
    require('./jpeg.cjs').validateJpeg(data, frame.width, frame.height);
    if (frame.sequence <= channel.lastSequence) throw fail('STALE_VIDEO_FRAME', 'Frame sequence must increase within a selected output');
    channel.lastSequence = frame.sequence;
    const receipt = await new Promise((resolve, reject) => {
      if (channel.pending) channel.pending.resolve(this.frameReceipt(channel.pending.frame, 'dropped', 'superseded-before-render'));
      channel.pending = { frame: { ...frame }, resolve, reject };
      if (!channel.busy) void this.drainFrames(channel);
    });
    return receipt;
  }
  async drainFrames(channel) {
    channel.busy = true;
    try {
      while (channel.pending && !channel.closed) {
        const item = channel.pending; channel.pending = null;
        try {
          if (this.sessionId !== channel.callId || this.generation !== channel.generation || channel.closed) { item.resolve(this.frameReceipt(item.frame, 'dropped', 'output-stopped')); continue; }
          const result = await this.outputs().write(item.frame);
          if (this.sessionId !== channel.callId || this.generation !== channel.generation || channel.closed) item.resolve(this.frameReceipt(item.frame, 'dropped', 'output-stopped'));
          else item.resolve(this.frameReceipt(item.frame, result.state, result.evidence));
        } catch (error) { item.reject(error); }
      }
    } finally { channel.busy = false; }
  }
  async clear() {
    const sending = Object.keys(this.sending), previousScene = this.nativeSceneId;
    if (this.stagePending) { const pending = this.stagePending; this.stagePending = null; clearTimeout(pending.timer); pending.reject(fail('STALE_CALL', 'Video session ended while publishing')); }
    for (const kind of this.frameChannels.keys()) this.closeFrames(kind);
    this.generation++; this.sessionVersion = (this.sessionVersion ?? 0) + 1; this.layoutVersion++; this.sessionId = null; this.nativeSceneId = null; this.cameraRequestedFormat = null; this.tracks.clear(); this.members.clear(); this.sourcesById.clear();
    return this.serial(async () => {
      if (this.enabled) {
        if ([2, 3].includes(previousScene)) await this.native(34, [], [1]).catch(error => { this.lastError = error.message; });
        await this.clearNativeLayout().catch(error => { this.cleanupError = error.message; });
        for (const kind of sending) await this.stopNative(kind, previousScene).catch(error => { this.cleanupError = error.message; });
      }
      if (!this.cleanupError) this.sending = {};
      else for (const current of Object.values(this.sending)) Object.assign(current, { state: 'failed', error: this.cleanupError });
      this.closeTestWindow();
    });
  }
}
module.exports = { VideoHost };

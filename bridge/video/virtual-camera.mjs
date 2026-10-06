import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCommand, killProcess } from '../audio/common.mjs';
import { videoFormat, videoIdentifier, encodeVideoFrame } from './protocol.mjs';
import { LatestVideoFrameQueue } from './queue.mjs';

export function virtualCameraConfig(config, platform = process.platform) {
  const backends = { linux: ['v4l2loopback'], win32: ['obs', 'unitycapture'], darwin: ['obs'] };
  if (!backends[platform]?.includes(config.backend)) throw new Error(`Select an explicit supported virtual-camera backend for ${platform}.`);
  const device = videoIdentifier(config.device, 'virtual camera device');
  if (/^(?:default|auto)$/i.test(device)) throw new Error('Default camera devices are forbidden.');
  if (platform === 'linux' && !/^\/dev\/video\d+$/.test(device)) throw new Error('v4l2loopback requires an explicit /dev/videoN path.');
  if (config.backend === 'obs' && device !== 'OBS Virtual Camera') throw new Error('The OBS backend requires the exact device name OBS Virtual Camera.');
  const startupTimeoutMs = config.startupTimeoutMs ?? 8000;
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) throw new Error('Invalid virtual-camera startup timeout.');
  const maxAgeMs = config.maxAgeMs ?? 1000, timeoutMs = config.timeoutMs ?? 3000;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 10000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid virtual-camera queue time limits.');
  return { ...videoFormat(config), backend: config.backend, device, startupTimeoutMs,
    ...(config.qqDeviceId === undefined ? {} : { qqDeviceId: videoIdentifier(config.qqDeviceId, 'QQ virtual camera device ID') }),
    python: config.python ?? (platform === 'win32' ? 'python' : 'python3'), maxAgeMs, timeoutMs };
}

/** Writes only to an explicitly selected, preinstalled virtual camera. Never installs or captures. */
export class VirtualCameraSink extends EventEmitter {
  constructor(config, dependencies = {}) {
    super();
    this.config = virtualCameraConfig(config, dependencies.platform ?? process.platform);
    this.spawn = dependencies.spawn ?? spawn;
    this.worker = fileURLToPath(new URL('./virtual_camera_worker.py', import.meta.url));
    this.state = 'stopped'; this.on('error', () => {});
  }
  async diagnostics() {
    try {
      const modules = JSON.parse(await runCommand(this.spawn, this.config.python, ['-u', this.worker, '--diagnostics'], { timeoutMs: this.config.startupTimeoutMs, maxBytes: 8192 }));
      return [{ id: 'video.virtual-camera.dependencies', level: modules.available ? 'ok' : 'error', message: modules.available ? 'Python video dependencies are available; no device was opened.' : 'Install bridge/video/requirements.txt in the selected Python environment.', detail: JSON.stringify(modules) },
        { id: 'video.virtual-camera.device', level: 'warning', message: 'Device availability is confirmed only by an explicit start. Diagnostics do not open the device.' }];
    } catch (error) { return [{ id: 'video.virtual-camera.dependencies', level: 'error', message: error.message }]; }
  }
  async start({ callId, sourceId, signal } = {}) {
    if (this.state !== 'stopped') throw new Error('Virtual camera is already starting or running.');
    videoIdentifier(callId, 'callId'); videoIdentifier(sourceId, 'sourceId');
    if (signal?.aborted) throw new Error('Virtual camera start was aborted.');
    this.state = 'starting'; this.nativeDeviceId = null; this.line = ''; this.stderr = ''; this.scope = { callId, sourceId };
    this.signal = signal; this.abort = () => { void this.stop(); }; signal?.addEventListener('abort', this.abort, { once: true });
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    ready.catch(() => {}); // A synchronous spawn failure can precede the await below.
    this.readyResolve = readyResolve; this.readyReject = readyReject;
    const timer = setTimeout(() => this.fail(new Error('Virtual camera startup timed out.')), this.config.startupTimeoutMs);
    try {
      const child = this.spawn(this.config.python, ['-u', this.worker, '--run', JSON.stringify({ ...this.config, callId, sourceId })], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      child.stdout.on('data', bytes => {
        if (this.child !== child) return;
        this.line += bytes.toString('utf8');
        if (Buffer.byteLength(this.line) > 32768) return this.fail(new Error('Virtual-camera worker exceeded its message limit.'));
        let end;
        while ((end = this.line.indexOf('\n')) >= 0) {
          const line = this.line.slice(0, end); this.line = this.line.slice(end + 1);
          try { this.message(JSON.parse(line)); } catch (error) { this.fail(error); return; }
        }
      });
      child.stderr.on('data', data => {
        if (this.child !== child) return;
        const stderr = this.stderr + data.toString();
        this.stderr = stderr.slice(-4096);
        // pyvirtualcam 0.15's v4l2loopback backend prints this exact prefix when
        // write(2) fails, then returns normally. Do not accept later frames as
        // healthy merely because camera.send() returned. Its fprintf has no
        // newline, so detecting it must not wait for a line terminator (or even
        // for the strerror suffix to arrive in the same stderr chunk).
        // https://github.com/letmaik/pyvirtualcam/blob/v0.15.0/pyvirtualcam/native_linux_v4l2loopback/virtual_output.h
        const failure = this.config.backend === 'v4l2loopback' && /(?:^|\n)error writing frame: ([^\r\n]*)/.exec(stderr);
        if (failure) this.fail(new Error(`Virtual-camera device write failed: ${failure[1].slice(0, 500) || 'backend write(2) failed'}`));
      });
      child.on('error', error => { if (this.child === child) this.fail(error); });
      child.stdin.on('error', error => { if (this.child === child) this.fail(error); });
      child.once('close', (code, signal) => { if (this.child === child && this.state !== 'stopped') this.fail(new Error(`Virtual-camera worker exited (${signal ?? code}): ${this.stderr}`)); });
      await ready;
      if (this.state !== 'starting' || this.child !== child) throw new Error('Virtual camera startup was cancelled.');
      this.queue = new LatestVideoFrameQueue((frame, options) => this.dispatch(frame, options), { ...this.scope, maxAgeMs: this.config.maxAgeMs, timeoutMs: this.config.timeoutMs });
      this.queue.on('receipt', receipt => {
        this.emit('receipt', receipt);
        if (receipt.state === 'failed') this.fail(new Error(receipt.error));
      });
      this.state = 'running';
    } catch (error) { await this.stop(); throw error; }
    finally { clearTimeout(timer); this.readyResolve = this.readyReject = null; }
  }
  message(message) {
    if (message.type === 'ready') {
      if (this.state !== 'starting' || message.device !== this.config.device || message.backend !== this.config.backend || ['width', 'height', 'fps', 'pixelFormat'].some(key => message[key] !== this.config[key])) throw new Error('Virtual-camera worker selected an unexpected device or format.');
      this.nativeDeviceId = videoIdentifier(message.nativeDeviceId, 'native virtual camera device ID');
      this.readyResolve?.();
    } else if (message.type === 'submitted') {
      const pending = this.pending;
      if (!pending || message.sequence !== pending.sequence || message.bytes !== pending.bytes || message.evidence !== 'pyvirtualcam-send') throw new Error('Virtual-camera worker reported an invalid frame acknowledgment.');
      this.pending = null; pending.cleanup(); pending.resolve({ evidence: 'pyvirtualcam-send' });
    } else if (message.type === 'error') throw new Error(message.error || 'Virtual-camera worker failed.');
    else throw new Error('Unknown virtual-camera worker message.');
  }
  dispatch(frame, { signal }) {
    if (this.state !== 'running' || !this.child || signal.aborted) return Promise.reject(new Error('Virtual camera is unavailable.'));
    if (this.pending) return Promise.reject(new Error('Virtual camera already has an in-flight frame.'));
    const child = this.child, packet = encodeVideoFrame(frame);
    if (child.stdin.writableLength > 0) return Promise.reject(new Error('Virtual-camera input did not drain.'));
    return new Promise((resolve, reject) => {
      const aborted = () => { if (this.pending === item) this.pending = null; item.cleanup(); reject(new Error('Virtual-camera frame was cancelled.')); };
      const item = { sequence: frame.sequence, bytes: frame.data.length, resolve, reject,
        cleanup: () => signal.removeEventListener('abort', aborted) };
      this.pending = item; signal.addEventListener('abort', aborted, { once: true });
      child.stdin.write(packet, error => { if (error && this.pending === item) { this.pending = null; item.cleanup(); reject(error); } });
    });
  }
  write(frame) {
    if (this.state !== 'running') throw new Error('Virtual camera is not running.');
    if (['width', 'height', 'fps', 'pixelFormat'].some(key => frame[key] !== this.config[key])) throw new Error('Video frame format differs from the configured virtual camera.');
    return this.queue.submit(frame);
  }
  // A virtual-camera driver can retain its last picture. Only stopping native camera transmission
  // proves that the remote application no longer sends it; there is no invented remote flush ack.
  async clear() { await this.stop(); }
  fail(error) {
    if (this.state === 'stopped' || this.state === 'stopping') return;
    this.readyReject?.(error); this.pending?.cleanup(); this.pending?.reject(error); this.pending = null;
    this.emit('error', error); void this.stop();
  }
  async stop() {
    if (this.state === 'stopped') return;
    if (this.state === 'stopping') return this.stopping;
    this.state = 'stopping'; this.readyReject?.(new Error('Virtual camera stopped.'));
    this.signal?.removeEventListener('abort', this.abort); this.signal = null;
    this.queue?.close(); this.queue = null;
    this.pending?.cleanup(); this.pending?.reject(new Error('Virtual camera stopped.')); this.pending = null;
    const child = this.child; this.child = null;
    this.stopping = killProcess(child).finally(() => { this.state = 'stopped'; this.stopping = null; });
    return this.stopping;
  }
}

export function createVirtualCameraSink(config, dependencies) { return new VirtualCameraSink(config, dependencies); }

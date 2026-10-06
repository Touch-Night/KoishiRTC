import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export function audioConfig(config = {}) {
  const sampleRate = config.sampleRate ?? 48000, channels = config.channels ?? 1, frameMs = config.frameMs ?? 20;
  if (![8000, 16000, 24000, 32000, 44100, 48000].includes(sampleRate)) throw new Error('Unsupported PCM sample rate.');
  if (![1, 2].includes(channels)) throw new Error('PCM channels must be 1 or 2.');
  if (![10, 20, 40, 60].includes(frameMs) || !Number.isInteger(sampleRate * frameMs / 1000)) throw new Error('Invalid audio frame duration.');
  const maxQueueMs = config.maxQueueMs ?? 2000;
  if (!Number.isInteger(maxQueueMs) || maxQueueMs < frameMs || maxQueueMs > 10000) throw new Error('maxQueueMs must be between one frame and 10000 ms.');
  return { ...config, sampleRate, channels, frameMs, maxQueueMs,
    frameBytes: sampleRate * frameMs / 1000 * channels * 2,
    maxQueueBytes: sampleRate * channels * 2 * maxQueueMs / 1000,
    startupTimeoutMs: config.startupTimeoutMs ?? 8000,
    commandTimeoutMs: config.commandTimeoutMs ?? 10000 };
}

export function requireDevices(config) {
  for (const key of ['inputDevice', 'outputDevice']) {
    if (typeof config[key] !== 'string' || !config[key].trim() || /^(?:default|@DEFAULT_.*@)$/i.test(config[key])) {
      throw new Error(`${key} must explicitly identify a virtual audio device; default devices are forbidden.`);
    }
  }
  if (config.inputDevice === config.outputDevice || config.inputDevice === `${config.outputDevice}.monitor`) {
    throw new Error('Input and output must use separate virtual audio routes.');
  }
}

export class AudioBackend extends EventEmitter {
  constructor(config, dependencies = {}) {
    super();
    this.config = audioConfig(config);
    this.spawn = dependencies.spawn ?? spawn;
    this.state = 'stopped'; this.muted = false; this.sequence = 0;
    this.pending = new Map(); this.completed = new Map(); this.unconfirmedBytes = 0; this.inputTail = Buffer.alloc(0);
    // Consumers should subscribe; retaining a handler avoids an unhandled process-level throw during shutdown.
    this.on('error', () => {});
  }
  accept(data, id) {
    if (this.state !== 'running') throw new Error('Audio backend is not running.');
    if (this.muted) throw new Error('Audio output is muted.');
    const frame = Buffer.isBuffer(data) || data instanceof Uint8Array ? null : data;
    if (frame && (frame.sampleRate !== this.config.sampleRate || frame.channels !== this.config.channels || frame.encoding !== 'pcm_s16le')) {
      throw new Error('Audio format differs from the configured PCM s16le format; resample before writing.');
    }
    const bytes = Buffer.from(frame ? frame.data : data);
    if (!bytes.length || bytes.length % (this.config.channels * 2)) throw new Error('PCM bytes must contain complete signed 16-bit frames.');
    if (bytes.length > this.config.maxQueueBytes) throw new Error('Audio write exceeds maxQueueMs; send smaller chunks.');
    if (typeof id !== 'string' || !id || id.length > 256 || this.pending.has(id)) throw new Error('Playback ID must be nonempty, unique while pending, and at most 256 characters.');
    // Limit metadata as well as the transport queue. A long continuous stream must provide flush boundaries.
    if (this.pending.size >= 4096 || this.unconfirmedBytes + bytes.length > this.config.sampleRate * this.config.channels * 2 * 60) {
      throw new Error('Too much unconfirmed audio; flush before sending more.');
    }
    const receipt = { id, ...(frame?.callId ? { callId: frame.callId } : {}), acceptedBytes: bytes.length, playedBytes: 0, state: 'queued' };
    this.pending.set(id, receipt); this.unconfirmedBytes += bytes.length;
    return { bytes, receipt };
  }
  progress(id, update) {
    const previous = this.pending.get(id);
    if (!previous) return;
    const receipt = { ...previous, ...update, id,
      playedBytes: Math.min(previous.acceptedBytes, Math.max(previous.playedBytes, Number(update.playedBytes) || 0)) };
    if (receipt.state === 'played' && receipt.playedBytes !== previous.acceptedBytes) return this.fail(new Error('Audio worker reported invalid playback completion.'));
    if (['played', 'cancelled', 'failed'].includes(receipt.state)) {
      this.pending.delete(id); this.unconfirmedBytes -= previous.acceptedBytes;
      this.completed.set(id, receipt);
      if (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value);
    } else this.pending.set(id, receipt);
    this.emit('playback', receipt);
  }
  cancelPending(state = 'cancelled', error) {
    for (const id of [...this.pending.keys()]) this.progress(id, { state, ...(error ? { error } : {}) });
  }
  audio(data) {
    if (this.state !== 'running') return;
    this.inputTail = Buffer.concat([this.inputTail, data]);
    while (this.inputTail.length >= this.config.frameBytes) {
      const frame = Buffer.from(this.inputTail.subarray(0, this.config.frameBytes));
      this.inputTail = this.inputTail.subarray(this.config.frameBytes);
      this.emit('audio', { data: frame, sampleRate: this.config.sampleRate, channels: this.config.channels,
        encoding: 'pcm_s16le', sequence: this.sequence++, timestamp: Date.now() });
    }
  }
  fail(error) {
    if (this.state === 'failed' || this.state === 'stopped') return;
    this.state = 'failed'; this.cancelPending('failed', error.message); this.emit('error', error);
    void this.stop().catch(() => {});
  }
  async setMuted(muted) {
    this.muted = !!muted;
    if (this.muted) await this.clear();
  }
}

export function runCommand(spawnFn, command, args, { timeoutMs = 5000, maxBytes = 1024 * 1024, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} timed out.`)); }, timeoutMs);
    child.stdout?.on('data', data => { stdout += data; if (Buffer.byteLength(stdout) > maxBytes) { child.kill(); finish(new Error('Device enumeration exceeded its output limit.')); } });
    child.stderr?.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => finish(code === 0 && !signal ? null : new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`), stdout));
  });
}

export function killProcess(child, timeoutMs = 1000) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, timeoutMs);
    child.once('close', finish); child.kill('SIGTERM');
  });
}

import { fileURLToPath } from 'node:url';
import { AudioBackend, requireDevices, runCommand, killProcess } from './common.mjs';

export class PortAudioBackend extends AudioBackend {
  constructor(config, dependencies = {}) {
    super(config, dependencies);
    this.python = config.python ?? (process.platform === 'win32' ? 'python' : 'python3');
    this.worker = fileURLToPath(new URL('./portaudio_worker.py', import.meta.url));
    this.requests = new Map(); this.requestSequence = 0;
  }
  async listDevices() {
    const result = JSON.parse(await runCommand(this.spawn, this.python, ['-u', this.worker, '--list'], { timeoutMs: this.config.startupTimeoutMs }));
    if (result.error) throw new Error(result.error);
    return result.devices;
  }
  async diagnostics() {
    const result = [];
    try { requireDevices(this.config); result.push({ id: 'audio.routes', level: 'ok', message: 'Explicit, separate audio routes configured.' }); }
    catch (error) { result.push({ id: 'audio.routes', level: 'error', message: error.message }); }
    try {
      const devices = await this.listDevices();
      result.push({ id: 'audio.portaudio', level: 'ok', message: 'Python sounddevice and PortAudio are available.' });
      for (const [key, direction] of [['inputDevice', 'input'], ['outputDevice', 'output']]) {
        const present = devices.some(device => device.id === this.config[key] && device.direction === direction);
        result.push({ id: `audio.${direction}`, level: present ? 'ok' : 'error', message: present ? `${direction} device is available.` : `Explicit ${direction} device not found. Enumerate and select its full pa: identifier.` });
      }
    } catch (error) { result.push({ id: 'audio.portaudio', level: 'error', message: `${error.message} Install the selected Python environment's sounddevice package (see docs/audio-setup.md).` }); }
    result.push({ id: 'audio.playback.evidence', level: 'warning', message: 'Playback progress uses PortAudio output-device timestamps; it does not prove that QQ or a remote participant received the sound.' });
    return result;
  }
  async start() {
    if (this.state === 'running') return;
    if (this.state === 'starting') throw new Error('Audio start is already in progress.');
    requireDevices(this.config);
    this.state = 'starting'; this.inputTail = Buffer.alloc(0); this.lineBuffer = ''; this.stderr = '';
    const config = { inputDevice: this.config.inputDevice, outputDevice: this.config.outputDevice,
      sampleRate: this.config.sampleRate, channels: this.config.channels, frameMs: this.config.frameMs,
      maxQueueBytes: this.config.maxQueueBytes };
    const child = this.spawn(this.python, ['-u', this.worker, '--run', JSON.stringify(config)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve; this.rejectReady = reject;
      child.stdout.on('data', bytes => {
        if (child !== this.child) return;
        this.lineBuffer += bytes.toString('utf8');
        if (Buffer.byteLength(this.lineBuffer) > Math.max(1024 * 1024, this.config.maxQueueBytes * 2)) return this.fail(new Error('Audio worker exceeded its protocol buffer limit.'));
        let newline;
        while ((newline = this.lineBuffer.indexOf('\n')) >= 0) {
          const line = this.lineBuffer.slice(0, newline); this.lineBuffer = this.lineBuffer.slice(newline + 1);
          try { this.message(JSON.parse(line)); }
          catch (error) { this.fail(new Error(`Invalid audio worker message: ${error.message}`)); return; }
        }
      });
      child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-8000); });
      child.on('error', error => { reject(error); this.fail(error); });
      child.stdin.on('error', error => { if (child === this.child && this.state !== 'stopped') this.fail(error); });
      child.once('close', (code, signal) => {
        const error = new Error(`Audio worker stopped (${signal ?? code}): ${this.stderr.trim()}`);
        reject(error);
        for (const item of this.requests.values()) { clearTimeout(item.timer); item.reject(error); }
        this.requests.clear();
        if (child === this.child && this.state !== 'stopped') this.fail(error);
      });
    });
    const timer = setTimeout(() => this.rejectReady?.(new Error('Audio worker startup timed out.')), this.config.startupTimeoutMs);
    try { await ready; if (this.state !== 'starting') throw new Error('Audio startup was cancelled.'); this.state = 'running'; }
    catch (error) { await this.stop(); throw error; }
    finally { clearTimeout(timer); this.resolveReady = this.rejectReady = null; }
  }
  message(message) {
    if (message.type === 'ready') {
      if (message.inputDevice !== this.config.inputDevice || message.outputDevice !== this.config.outputDevice) throw new Error('Worker selected unexpected audio devices.');
      this.resolveReady?.();
    } else if (message.type === 'audio') {
      if (typeof message.data !== 'string' || message.sampleRate !== this.config.sampleRate || message.channels !== this.config.channels) throw new Error('Invalid captured PCM format.');
      this.audio(Buffer.from(message.data, 'base64'));
    } else if (message.type === 'playback') {
      if (!['playing', 'played', 'cancelled', 'failed'].includes(message.state)) throw new Error('Invalid playback state.');
      this.progress(message.id, { state: message.state, playedBytes: message.playedBytes,
        evidence: message.evidence, ...(message.error ? { error: message.error } : {}) });
    } else if (message.type === 'ack') {
      const pending = this.requests.get(message.requestId);
      if (pending) { this.requests.delete(message.requestId); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message); }
    } else if (message.type === 'error') {
      const error = new Error(message.error || 'Audio device failed.'); this.rejectReady?.(error); this.fail(error);
    }
  }
  command(type, fields = {}, timeoutMs = this.config.commandTimeoutMs) {
    const child = this.child;
    if (!child || child.stdin.destroyed) return Promise.reject(new Error('Audio worker is unavailable.'));
    if (this.requests.size >= 128) return Promise.reject(new Error('Too many pending audio commands.'));
    const line = JSON.stringify({ type, requestId: String(++this.requestSequence), ...fields }) + '\n';
    if (child.stdin.writableLength + Buffer.byteLength(line) > this.config.maxQueueBytes * 2 + 8192) return Promise.reject(new Error('Audio worker command queue is full.'));
    const requestId = String(this.requestSequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(requestId); reject(new Error(`Audio ${type} timed out.`)); this.fail(new Error(`Audio ${type} did not complete; device disabled.`)); }, timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer });
      child.stdin.write(line, error => { if (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); } });
    });
  }
  async write(data, id) {
    const item = this.accept(data, id);
    try { await this.command('write', { id, data: item.bytes.toString('base64') }); }
    catch (error) { this.progress(id, { state: 'failed', error: error.message }); throw error; }
    return { ...(this.pending.get(id) ?? this.completed.get(id) ?? item.receipt) };
  }
  async flush() { if (this.state === 'running') await this.command('flush'); }
  async clear() {
    if (this.child && this.state === 'running') await this.command('clear');
    this.cancelPending();
  }
  async stop() {
    this.state = 'stopped'; this.cancelPending();
    const child = this.child;
    if (child) {
      try { await this.command('stop', {}, 1000); } catch { /* Force-stop a hung/disconnected device below. */ }
      if (this.child === child) this.child = null;
      await killProcess(child);
    }
    this.inputTail = Buffer.alloc(0);
  }
}

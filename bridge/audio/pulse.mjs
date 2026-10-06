import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AudioBackend, requireDevices, runCommand, killProcess } from './common.mjs';

export class PulseAudioBackend extends AudioBackend {
  constructor(config, dependencies = {}) {
    super(config, dependencies);
    this.access = dependencies.access ?? access;
    this.shim = config.noMoveShim ?? fileURLToPath(new URL('./pulse-no-move.so', import.meta.url));
    this.queue = []; this.queueBytes = 0; this.epoch = 0;
  }
  async listDevices() {
    const lists = await Promise.all(['sources', 'sinks'].map(kind => runCommand(this.spawn, this.config.pactl ?? 'pactl',
      ['--format=json', 'list', kind], { env: this.environment(false) })));
    return lists.flatMap((text, index) => JSON.parse(text).map(device => ({
      id: device.name, name: device.description || device.name, direction: index === 0 ? 'input' : 'output',
      backend: 'pulse', sampleRate: Number(String(device.sample_specification).match(/(\d+)Hz/)?.[1]) || undefined,
      channels: Number(String(device.sample_specification).match(/(\d+)ch/)?.[1]) || undefined,
    })));
  }
  environment(preload = true) {
    return { ...process.env, LC_ALL: 'C', LANG: 'C', ...(this.config.pulseServer ? { PULSE_SERVER: this.config.pulseServer } : {}),
      ...(preload ? { LD_PRELOAD: this.shim } : {}) };
  }
  async diagnostics() {
    const result = [];
    try { requireDevices(this.config); result.push({ id: 'audio.routes', level: 'ok', message: 'Explicit, separate audio routes configured.' }); }
    catch (error) { result.push({ id: 'audio.routes', level: 'error', message: error.message }); }
    try { await this.access(this.shim); result.push({ id: 'audio.pulse.pin', level: 'ok', message: 'PulseAudio no-move shim is installed.' }); }
    catch { result.push({ id: 'audio.pulse.pin', level: 'error', message: 'Run node bridge/audio/build-pulse-shim.mjs; refusing unpinned PulseAudio capture.' }); }
    try {
      const devices = await this.listDevices();
      for (const [key, direction] of [['inputDevice', 'input'], ['outputDevice', 'output']]) {
        const present = devices.some(device => device.direction === direction && device.id === this.config[key]);
        result.push({ id: `audio.${direction}`, level: present ? 'ok' : 'error', message: present ? `${direction} device is available.` : `${direction} device not found: ${this.config[key] ?? '(unset)'}` });
      }
      for (const command of [this.config.parec ?? 'parec', this.config.pacat ?? 'pacat']) await runCommand(this.spawn, command, ['--version']);
      result.push({ id: 'audio.pulse.tools', level: 'ok', message: 'PulseAudio clients available; PipeWire-Pulse uses the same protocol.' });
    } catch (error) { result.push({ id: 'audio.pulse.tools', level: 'error', message: error.message }); }
    result.push({ id: 'audio.playback.evidence', level: 'warning', message: 'playedBytes are confirmed only after PulseAudio drains the output stream, not when bytes enter its pipe. Completion does not prove the remote QQ participant heard audio.' });
    return result;
  }
  args(device, record) {
    return [record ? '--record' : '--playback', '--raw', '--verbose', `--device=${device}`, '--format=s16le',
      `--rate=${this.config.sampleRate}`, `--channels=${this.config.channels}`, '--latency-msec=60',
      `--process-time-msec=${this.config.frameMs}`, '--client-name=KoishiRTC',
      `--stream-name=KoishiRTC-${record ? 'receive' : 'transmit'}`];
  }
  open(record) {
    const device = record ? this.config.inputDevice : this.config.outputDevice;
    const child = this.spawn(record ? this.config.parec ?? 'parec' : this.config.pacat ?? 'pacat', this.args(device, record),
      { stdio: ['pipe', 'pipe', 'pipe'], env: this.environment(), windowsHide: true });
    const session = { child, ids: new Set(), retired: false, drained: false, started: false, text: '', closed: false };
    session.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('PulseAudio device connection timed out.')), this.config.startupTimeoutMs);
      const ready = () => { clearTimeout(timeout); resolve(); };
      const failed = error => { clearTimeout(timeout); reject(error); };
      child.once('error', failed);
      child.stderr.on('data', data => {
        if (session.retired) return;
        session.text = (session.text + data.toString()).slice(-16000);
        if (/cannot be preloaded|ignored.*preload/i.test(session.text)) failed(new Error('PulseAudio pinning library failed to load; audio disabled.'));
        const connected = session.text.match(/Connected to device (.+?) \(index:/);
        if (connected) {
          if (connected[1] !== device) failed(new Error('PulseAudio selected an unexpected device; refusing audio.'));
          else ready();
        }
        if (session.text.includes('Playback stream drained.')) session.drained = true;
        if (session.text.includes('Stream moved to device')) this.fail(new Error('PulseAudio unexpectedly moved an explicitly pinned stream.'));
        if (session.text.includes('Stream started.') && !session.started) {
          session.started = true;
          for (const id of session.ids) this.progress(id, { state: 'playing', playedBytes: 0, evidence: 'pulse-stream-started' });
        }
      });
      child.once('close', (code, signal) => {
        session.closed = true;
        failed(new Error(`PulseAudio ${record ? 'capture' : 'playback'} stopped (${signal ?? code}): ${session.text.slice(-1000)}`));
        if (session.retired) return;
        if (!record && session.draining && session.drained && code === 0 && !signal) {
          for (const id of session.ids) this.progress(id, { state: 'played', playedBytes: this.pending.get(id)?.acceptedBytes ?? 0, evidence: 'pulse-stream-drained' });
          session.resolveDrain?.();
        } else {
          const error = new Error(`PulseAudio ${record ? 'capture' : 'playback'} disconnected; no default-device fallback (${signal ?? code}).`);
          session.rejectDrain?.(error); this.fail(error);
        }
      });
      child.stdin.on('error', error => { if (!session.retired && !session.draining) this.fail(error); });
    });
    session.ready.catch(() => {});
    if (record) child.stdout.on('data', data => { if (!session.retired) this.audio(data); });
    else child.stdout.resume();
    return session;
  }
  async start() {
    if (this.state === 'running') return;
    if (this.state === 'starting') throw new Error('Audio start is already in progress.');
    requireDevices(this.config);
    this.state = 'starting'; this.inputTail = Buffer.alloc(0);
    const lifecycle = this.lifecycle = (this.lifecycle ?? 0) + 1;
    try {
      await this.access(this.shim);
      const devices = await this.listDevices();
      for (const [id, direction] of [[this.config.inputDevice, 'input'], [this.config.outputDevice, 'output']]) {
        if (!devices.some(device => device.id === id && device.direction === direction)) throw new Error(`Explicit ${direction} device is unavailable: ${id}`);
      }
      if (this.state !== 'starting' || this.lifecycle !== lifecycle) throw new Error('Audio startup was cancelled.');
      this.input = this.open(true); await this.input.ready;
      if (this.state !== 'starting' || this.lifecycle !== lifecycle || this.input.closed) throw new Error('Audio startup was cancelled.');
      this.state = 'running';
    }
    catch (error) { if (this.lifecycle === lifecycle) await this.stop(); throw error; }
  }
  async write(data, id) {
    if (this.flushing) await this.flushing;
    const size = (Buffer.isBuffer(data) || data instanceof Uint8Array ? data : data?.data)?.length ?? 0;
    if (this.queueBytes + size > this.config.maxQueueBytes) throw new Error('Audio output queue is full.');
    const item = this.accept(data, id);
    this.queue.push(item); this.queueBytes += item.bytes.length; clearTimeout(this.idleTimer);
    this.pump();
    return { ...item.receipt };
  }
  pump() {
    if (this.pumping) return;
    const epoch = this.epoch;
    this.pumping = (async () => {
      while (this.queue.length && this.state === 'running' && epoch === this.epoch) {
        if (!this.output) { this.output = this.open(false); await this.output.ready; }
        if (epoch !== this.epoch) return;
        const session = this.output, item = this.queue.shift();
        session.ids.add(item.receipt.id);
        await new Promise((resolve, reject) => session.child.stdin.write(item.bytes, error => error ? reject(error) : resolve()));
        if (epoch !== this.epoch) return;
        this.queueBytes -= item.bytes.length;
        if (session.started) this.progress(item.receipt.id, { state: 'playing', playedBytes: 0, evidence: 'pulse-stream-started' });
      }
    })().catch(error => { if (epoch === this.epoch) this.fail(error); }).finally(() => {
      this.pumping = null;
      if (this.queue.length && this.state === 'running') this.pump();
      else if (this.output && !this.flushing && this.state === 'running') {
        this.idleTimer = setTimeout(() => { void this.flush().catch(error => this.fail(error)); }, this.config.idleDrainMs ?? 100);
      }
    });
  }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async drain() {
    clearTimeout(this.idleTimer);
    if (this.draining) return this.draining;
    if (this.pumping) await this.pumping;
    const session = this.output;
    if (!session || session.retired) return;
    this.draining = new Promise((resolve, reject) => {
      session.resolveDrain = resolve; session.rejectDrain = reject; session.draining = true;
      session.child.stdin.end();
    });
    const timeout = setTimeout(() => session.rejectDrain?.(new Error('PulseAudio drain timed out.')), this.config.commandTimeoutMs);
    try { await this.draining; }
    catch (error) { session.retired = true; await killProcess(session.child); this.fail(error); throw error; }
    finally { clearTimeout(timeout); if (this.output === session) this.output = null; this.draining = null; }
  }
  async clear() {
    clearTimeout(this.idleTimer); this.epoch++;
    this.queue = []; this.queueBytes = 0; this.cancelPending();
    const output = this.output; this.output = null;
    if (output) { output.retired = true; output.resolveDrain?.(); await killProcess(output.child); }
    this.draining = null;
  }
  async stop() {
    this.lifecycle = (this.lifecycle ?? 0) + 1;
    this.state = 'stopped'; await this.clear();
    const input = this.input; this.input = null;
    if (input) { input.retired = true; await killProcess(input.child); }
    this.inputTail = Buffer.alloc(0);
  }
}

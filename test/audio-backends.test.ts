import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// The bridge deliberately runs as ESM independently of Koishi's TypeScript bundle.
import { createAudioBackend } from '../bridge/audio/index.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin: Writable;
  exitCode: number | null = null; signalCode: string | null = null;
  writes: Buffer[] = []; ended = false;
  heldWrite?: (error?: Error | null) => void;
  onWrite?: (bytes: Buffer, done: (error?: Error | null) => void) => void;
  constructor() {
    super();
    this.stdin = new Writable({ write: (data, _encoding, done) => {
      this.writes.push(Buffer.from(data)); this.onWrite ? this.onWrite(Buffer.from(data), done) : done();
    }, final: done => { this.ended = true; done(); } });
  }
  close(code = 0, signal: string | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.heldWrite?.(new Error('process closed')); this.heldWrite = undefined;
    this.stdin.destroy(); this.emit('close', code, signal);
  }
  kill(signal = 'SIGTERM') { queueMicrotask(() => this.close(0, signal)); return true; }
  json(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n'); }
}

function fixture(backend = 'pulse', extra: Record<string, unknown> = {}) {
  const children: { command: string; args: string[]; options: any; child: FakeChild }[] = [];
  const config = { backend, inputDevice: backend === 'pulse' ? 'rtc_rx.monitor' : 'pa:input',
    outputDevice: backend === 'pulse' ? 'rtc_tx' : 'pa:output', sampleRate: 48000, channels: 1,
    idleDrainMs: 60_000, startupTimeoutMs: 200, commandTimeoutMs: 200, ...extra };
  const spawn = (command: string, args: string[], options: any) => {
    const child = new FakeChild(); children.push({ command, args, options, child });
    queueMicrotask(() => {
      if (command === 'pactl') {
        child.stdout.write(JSON.stringify([{ name: args.at(-1) === 'sources' ? 'rtc_rx.monitor' : 'rtc_tx', description: 'Virtual cable', sample_specification: 's16le 1ch 48000Hz' }])); child.close();
      } else if (args.includes('--version')) child.close();
      else if (args.includes('--list')) {
        child.json({ devices: [{ id: 'pa:input', name: 'Input cable', direction: 'input' }, { id: 'pa:output', name: 'Output cable', direction: 'output' }] }); child.close();
      } else if (args.includes('--run')) {
        child.onWrite = (bytes, done) => {
          const message = JSON.parse(bytes.toString());
          child.json({ type: 'ack', requestId: message.requestId }); done();
          if (message.type === 'stop') queueMicrotask(() => child.close());
        };
        child.json({ type: 'ready', inputDevice: config.inputDevice, outputDevice: config.outputDevice });
      } else {
        if (command === 'pacat' && extra.holdPulseWrite) child.onWrite = (_bytes, done) => { child.heldWrite = done; };
        const device = args.find(arg => arg.startsWith('--device='))!.slice(9);
        child.stderr.write(`Stream successfully created.\nConnected to device ${device} (index: 4, suspended: no).\n`);
      }
    });
    return child;
  };
  const audio = createAudioBackend(config, { spawn, platform: backend === 'pulse' ? 'linux' : 'win32', access: async () => {} });
  return { audio, children, config, input: () => children.find(item => item.command === 'parec')!.child,
    output: () => children.filter(item => item.command === 'pacat').at(-1)!.child,
    worker: () => children.find(item => item.args.includes('--run'))!.child };
}

test('explicit virtual routes and formats are mandatory; diagnostics never start recording', async () => {
  const f = fixture();
  assert.equal((await f.audio.listDevices()).length, 2);
  assert.equal((await f.audio.diagnostics()).some((item: any) => item.level === 'error'), false);
  assert.equal(f.children.some(item => item.args.includes('--record') || item.args.includes('--playback')), false);
  await assert.rejects(fixture('pulse', { inputDevice: '@DEFAULT_SOURCE@' }).audio.start(), /default devices/i);
  await assert.rejects(fixture('pulse', { inputDevice: 'rtc_tx.monitor' }).audio.start(), /separate/);
  await assert.rejects(fixture('pulse', { inputDevice: 'absent' }).audio.start(), /unavailable/);
  assert.throws(() => createAudioBackend({ channels: 3 }), /channels/);
  assert.throws(() => createAudioBackend({}, { platform: 'android' }), /not supported/);
});

test('Pulse capture pins a named source and yields fixed isolated PCM frames', async () => {
  const f = fixture(), frames: any[] = [];
  f.audio.on('audio', (frame: any) => frames.push(frame)); await f.audio.start();
  const capture = f.children.find(item => item.command === 'parec')!;
  assert.match(capture.options.env.LD_PRELOAD, /pulse-no-move\.so$/);
  assert.ok(capture.args.includes('--device=rtc_rx.monitor'));
  assert.ok(capture.args.includes('--format=s16le'));
  assert.equal(f.children.some(item => item.command === 'pacat'), false, 'no output stream is opened until explicitly writing');
  f.input().stdout.write(Buffer.alloc(100)); f.input().stdout.write(Buffer.alloc(3740));
  assert.deepEqual(frames.map(frame => [frame.sequence, frame.data.length, frame.encoding]), [[0, 1920, 'pcm_s16le'], [1, 1920, 'pcm_s16le']]);
  await f.audio.stop(); f.input().stdout.write(Buffer.alloc(1920)); assert.equal(frames.length, 2);
});

test('Pulse playback is only complete after a confirmed server drain, not pipe acceptance or exit zero', async () => {
  const f = fixture(), receipts: any[] = []; f.audio.on('playback', (value: any) => receipts.push(value));
  await f.audio.start();
  const result = await f.audio.write(Buffer.alloc(1920), 'one'); await tick();
  assert.equal(result.state, 'queued'); assert.equal(result.playedBytes, 0);
  assert.equal(receipts.some(value => value.state === 'played'), false);
  const draining = f.audio.flush(); await tick(); assert.equal(f.output().ended, true);
  f.output().stderr.write('Playback stream drained.\n'); f.output().close(); await draining;
  assert.equal(receipts.at(-1).state, 'played'); assert.equal(receipts.at(-1).playedBytes, 1920);
  await f.audio.write(Buffer.alloc(1920), 'two'); await tick();
  f.output().close(); await tick();
  assert.equal(receipts.at(-1).state, 'failed', 'an unexpected successful process exit is not evidence of playback');
  assert.equal(receipts.at(-1).playedBytes, 0); await f.audio.stop();
});

test('Pulse clear/mute discard pending output while capture stays alive and the queue is finite', async () => {
  const f = fixture('pulse', { maxQueueMs: 20, holdPulseWrite: true }), receipts: any[] = []; f.audio.on('playback', (value: any) => receipts.push(value));
  await f.audio.start();
  await assert.rejects(f.audio.write(Buffer.alloc(3), 'bad'), /complete/);
  await f.audio.write(Buffer.alloc(1920), 'queued');
  await assert.rejects(f.audio.write(Buffer.alloc(1920), 'overflow'), /queue is full/);
  await tick(); await f.audio.setMuted(true);
  assert.equal(receipts.at(-1).state, 'cancelled'); assert.equal(receipts.at(-1).playedBytes, 0);
  assert.equal(f.input().exitCode, null);
  await assert.rejects(f.audio.write(Buffer.alloc(1920), 'muted'), /muted/);
  await f.audio.setMuted(false); await f.audio.write(Buffer.alloc(1920), 'after-mute'); await tick();
  f.input().close(1); await tick();
  assert.equal(f.audio.state, 'stopped');
  assert.equal(f.children.filter(item => item.command === 'parec').length, 1, 'capture is not retried on a default microphone');
  await f.audio.stop();
});

test('PortAudio uses isolated process acknowledgements and does not invent playback progress', async () => {
  const f = fixture('portaudio'), receipts: any[] = [], frames: any[] = [];
  f.audio.on('playback', (value: any) => receipts.push(value)); f.audio.on('audio', (frame: any) => frames.push(frame));
  await f.audio.start(); const worker = f.worker();
  const initial = await f.audio.write({ callId: 'call-a', data: Buffer.alloc(1920), sampleRate: 48000, channels: 1, encoding: 'pcm_s16le' }, 'p');
  assert.equal(initial.state, 'queued'); assert.equal(initial.playedBytes, 0);
  assert.equal(receipts.length, 0);
  worker.json({ type: 'playback', id: 'p', state: 'playing', playedBytes: 960, evidence: 'portaudio-dac-clock' });
  assert.equal(receipts.at(-1).playedBytes, 960);
  assert.equal(receipts.at(-1).callId, 'call-a');
  worker.json({ type: 'audio', data: Buffer.alloc(1920).toString('base64'), sampleRate: 48000, channels: 1 });
  assert.equal(frames.length, 1);
  await f.audio.clear(); assert.equal(receipts.at(-1).state, 'cancelled'); assert.equal(receipts.at(-1).playedBytes, 960);
  worker.json({ type: 'playback', id: 'p', state: 'played', playedBytes: 1920 });
  assert.equal(receipts.at(-1).state, 'cancelled', 'late acknowledgements cannot revive cleared audio');
  await assert.rejects(f.audio.write({ data: Buffer.alloc(2), sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' }, 'format'), /format differs/);
  await f.audio.stop();
});

test('PortAudio disconnect fails pending playback and never starts a replacement process', async () => {
  const f = fixture('portaudio'), receipts: any[] = []; f.audio.on('playback', (value: any) => receipts.push(value));
  await f.audio.start(); await f.audio.write(Buffer.alloc(1920), 'lost'); f.worker().close(1); await tick();
  assert.equal(receipts.at(-1).state, 'failed'); assert.equal(receipts.at(-1).playedBytes, 0);
  assert.equal(f.children.filter(item => item.args.includes('--run')).length, 1); await f.audio.stop();
});

test('Python callback progresses only after DAC timestamps and preserves exact audio bytes without devices', (context) => {
  const workerPath = fileURLToPath(new URL('../bridge/audio/portaudio_worker.py', import.meta.url));
  const script = `
import importlib.util, json, types
spec = importlib.util.spec_from_file_location('worker', ${JSON.stringify(workerPath)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class SD:
    CallbackAbort = RuntimeError
    def query_hostapis(self): return [{'name':'test'}]
    def query_devices(self): return []
w=m.Worker(SD(), {'sampleRate':48000,'channels':1,'frameMs':20,'maxQueueBytes':3840})
data=bytes(range(256))*7+bytes(range(128))
w.command({'type':'write','requestId':'r','id':'audio','data':m.base64.b64encode(data).decode()})
out=bytearray(1920)
w.output_callback(out,960,types.SimpleNamespace(currentTime=10.0,outputBufferDacTime=10.1),False)
assert bytes(out)==data
assert w.entries['audio']['played']==0
w.output_callback(out,960,types.SimpleNamespace(currentTime=10.11,outputBufferDacTime=10.13),False)
assert 'audio' in w.entries
w.output_callback(out,960,types.SimpleNamespace(currentTime=10.13,outputBufferDacTime=10.15),False)
assert 'audio' not in w.entries
events=[]
while not w.events.empty(): events.append(w.events.get_nowait())
played=[x for x in events if x.get('state')=='played']
assert len(played)==1 and played[0]['playedBytes']==1920
assert bytes(out)==bytes(1920)
print('isolated DAC clock and silence checks passed')
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return context.skip('python3 is unavailable; no real devices were used.');
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /checks passed/);
});

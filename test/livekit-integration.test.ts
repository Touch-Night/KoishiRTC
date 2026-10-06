import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { LiveKitProvider } from '../src/providers/livekit.js';
import { RtcManager } from '../src/core.js';
import type { AudioFrame, VideoFrame } from '../src/types.js';
async function port() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return p as number; }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, label: string, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(50); } throw new Error(`timeout: ${label}`); }

test('real local LiveKit server: duplex PCM, independent camera/screen, authorized video receive and cleanup', { skip: !process.env.RTC_LIVEKIT_SERVER, timeout: 60000 }, async () => {
  const sdk = await import('@livekit/rtc-node'), { default: sharp } = await import('sharp');
  const dir = await mkdtemp(join(tmpdir(), 'rtc-livekit-')), http = await port(), tcp = await port(), udp = await port();
  const apiKey = randomBytes(12).toString('hex'), apiSecret = randomBytes(32).toString('hex');
  const configPath = join(dir, 'config.yaml');
  await writeFile(configPath, `port: ${http}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\nkeys:\n  ${apiKey}: ${apiSecret}\nlogging:\n  level: error\n`, { mode: 0o600 });
  const server = spawn(process.env.RTC_LIVEKIT_SERVER!, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; server.stderr.on('data', b => { logs = (logs + b.toString()).slice(-3000); }); server.stdout.on('data', b => { logs = (logs + b.toString()).slice(-3000); });
  const manager = new RtcManager(), p = new LiveKitProvider({ id: 'test-a', selfId: 'rtc-a', url: `ws://127.0.0.1:${http}`, apiKey, apiSecret, roomNames: ['offline-test'] }), q = new LiveKitProvider({ id: 'test-b', selfId: 'rtc-b', url: `ws://127.0.0.1:${http}`, apiKey, apiSecret, roomNames: ['offline-test'] });
  const audio: AudioFrame[] = [], video: VideoFrame[] = []; const diagnostics: unknown[] = []; manager.on('diagnostic', e => { diagnostics.push(e); });
  q.events.on('event', e => { if (e.audio) audio.push(e.audio); if (e.video) video.push(e.video); });
  try {
    await until(async () => { if (server.exitCode !== null) throw new Error(logs); try { return (await fetch(`http://127.0.0.1:${http}`)).ok; } catch { return false; } }, 'local server');
    await manager.register(p); await manager.register(q); const control = manager.controller('integration');
    const a = await control.dial(p.id, { kind: 'group', targetId: 'offline-test' }), b = await control.dial(q.id, { kind: 'group', targetId: 'offline-test' });
    assert.equal(a.state, 'connected'); assert.equal(b.state, 'connected');
    for (let i = 0; i < 12; i++) { const pcm = Buffer.alloc(3840); for (let n = 0; n < 1920; n++) pcm.writeInt16LE(Math.round(Math.sin((n + i * 1920) * .11) * 7000), n * 2); await control.writeAudio(a.id, { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le', sequence: i, timestamp: Date.now(), data: pcm }); }
    await until(() => audio.some(f => f.speakerId === 'rtc-a' && f.data.some(b => b !== 0)), 'decoded remote PCM');
    await control.sendVideo(a.id, { kind: 'camera', sourceId: 'external-frames' }); await control.sendVideo(a.id, { kind: 'screen', sourceId: 'external-frames' });
    await until(async () => (await control.videoState(b.id)).tracks.length === 2, 'two published tracks');
    assert.equal(video.length, 0, 'no pixels delivered before explicit subscription');
    for (const kind of ['camera', 'screen'] as const) await control.subscribeVideo(b.id, { participantId: 'rtc-a', kind });
    const red = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#ff0000' } }).jpeg().toBuffer(), blue = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#0000ff' } }).jpeg().toBuffer();
    for (let i = 0; i < 25; i++) { for (const kind of ['camera', 'screen'] as const) await control.writeVideo(a.id, { kind, encoding: 'jpeg', width: 320, height: 180, sequence: i, timestamp: Date.now(), data: kind === 'camera' ? red : blue }); await delay(60); }
    await until(() => video.some(f => f.kind === 'camera') && video.some(f => f.kind === 'screen'), 'independent video channels');
    for (const kind of ['camera', 'screen'] as const) { const f = video.find(f => f.kind === kind)!; const stats = await sharp(f.data).stats(); assert.equal(f.evidence, 'livekit-decoded-frame-and-jpeg-encode'); assert.ok(stats.channels[kind === 'camera' ? 0 : 2]!.mean > 180, `${kind} color preserved`); }
    const reverse: AudioFrame[] = []; p.events.on('event', e => { if (e.audio) reverse.push(e.audio); });
    await control.writeAudio(b.id, { sampleRate: 48000, channels: 2, encoding: 'pcm_s16le', sequence: 0, timestamp: Date.now(), data: Buffer.alloc(3840, 10) });
    await until(() => reverse.some(f => f.speakerId === 'rtc-b'), 'reverse PCM');
    await control.hangup(a.id); await control.hangup(b.id); assert.equal(manager.getCall(a.id).state, 'ended'); assert.equal(manager.getCall(b.id).state, 'ended');
    await delay(50); assert.deepEqual(diagnostics, [], 'normal teardown must not report stale media errors');
    console.log(`LiveKit local transport verified: ${audio.length} decoded PCM frames, ${video.length} decoded JPEG frames across both channels`);
  } finally {
    await manager.dispose(); await sdk.dispose(); server.kill('SIGTERM'); if (server.exitCode === null) await Promise.race([once(server, 'exit'), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); await rm(dir, { recursive: true, force: true });
  }
});

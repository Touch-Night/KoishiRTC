import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramProvider, type TelegramTransport } from '../src/providers/telegram.js';
import { RtcManager, type CallSnapshot, type ProviderEvent } from '../src/core.js';
const pause = () => new Promise<void>(r => setImmediate(r));
const config = { id: 'tg', selfId: '1', python: 'python3', configPath: '/private/telegram.json', allowedChatIds: ['2','-1003'] };
const snap = (id = 'tg:one'): CallSnapshot => ({ id, providerId: 'tg', account: { platform: 'telegram', selfId: '1' }, kind: 'direct', targetId: '2', direction: 'outgoing', state: 'connected', createdAt: 1, updatedAt: 1, participants: [{ id: '2', identity: 'platform' }], muted: false });
const pcm = (callId = 'tg:one', length = 3840) => ({ callId, encoding: 'pcm_s16le' as const, sampleRate: 48000, channels: 2 as const, sequence: 0, timestamp: 1, data: new Uint8Array(length).fill(12) });
class Fake implements TelegramTransport {
  emit!: (p: any) => void; offline!: () => void; requests: Array<[string, any]> = []; stopped = 0; identity: any = { selfId: '1', platform: 'telegram', bot: false }; audioGate?: Promise<void>;
  tracks: any[] = []; sending: any = {};
  async start(_c: any, emit: (p: any) => void, offline: () => void) { this.emit = emit; this.offline = offline; return this.identity; }
  async stop() { this.stopped++; }
  state(callId = 'tg:one') { return { callId, supported: true, tracks: this.tracks, sending: this.sending }; }
  async request(op: string, args: any): Promise<any> {
    this.requests.push([op,args]);
    if (op === 'dial') { const c = { ...snap(), state: 'dialing', kind: args.kind, targetId: args.targetId }; this.emit({ type: 'call', call: c }); return c; }
    if (op === 'audio.write') { await this.audioGate; return { submittedBytes: 1920 }; }
    if (op === 'ping') return { connected: true };
    if (op === 'mute') this.emit({ type: 'call', call: { ...snap(args.callId), muted: args.muted } });
    if (op === 'video.subscribe') { const t = { trackId: `${args.kind}:${args.participantId}`, participantId: args.participantId, kind: args.kind, available: true, subscribed: true, hasFrame: false, decodedFrameAt: null }; this.tracks.push(t); return t; }
    if (op === 'video.unsubscribe') this.tracks = this.tracks.filter(t => t.trackId !== args.trackId);
    if (op === 'video.clear') { this.tracks = []; this.sending = {}; }
    if (op === 'video.send') this.sending[args.kind] = { sourceId: args.sourceId, state: 'sending', ...(args.framing === undefined ? {} : { framing: args.framing }) };
    if (op === 'video.stop') delete this.sending[args.kind];
    if (op === 'video.write') return { callId: args.callId, kind: args.kind, sequence: args.sequence, state: 'submitted', acceptedBytes: Buffer.from(args.data,'base64').length, evidence: 'ntgcalls-i420-input-submit' };
    return this.state(args.callId);
  }
}
async function fixture(extra = {}) {
  const fake = new Fake(), events: ProviderEvent[] = []; let tick!: () => void;
  const provider = new TelegramProvider({ ...config, ...extra }, { transport: fake, every: fn => { tick = fn; return () => {}; } });
  provider.events.on('event', event => events.push(event)); await provider.start();
  return { fake, provider, events, tick: () => tick(), connected: (c = snap()) => fake.emit({ type: 'call', call: c }) };
}

test('Telegram validates ordinary account identity, allowlist and configuration before any call', async t => {
  assert.throws(() => new TelegramProvider({ ...config, configPath: 'relative.json' }));
  assert.throws(() => new TelegramProvider({ ...config, allowedChatIds: ['@name'] }));
  const f = await fixture({ allowedChatIds: [] }); t.after(() => f.provider.stop());
  assert.equal(f.provider.capabilities().dial.supported, false);
  await assert.rejects(f.provider.dial({ kind: 'direct', targetId: '2' }), (e: any) => e.code === 'CHAT_NOT_ALLOWED');
  assert.equal(f.fake.requests.length, 0);
  for (const identity of [{ selfId: '99', platform: 'telegram', bot: false }, { selfId: '1', platform: 'telegram', bot: true }]) {
    const fake = new Fake(); fake.identity = identity; const p = new TelegramProvider(config, { transport: fake });
    await assert.rejects(p.start(), (e: any) => e.code === 'IDENTITY_MISMATCH'); assert.equal(fake.stopped, 1); assert.equal(p.capabilities().dial.supported, false);
  }
});

test('Telegram direct/group/video requests reach SDK without activating devices; invalid targets never dispatch', async t => {
  const f = await fixture(); t.after(() => f.provider.stop());
  assert.equal(f.provider.capabilities().speakerIdentity.supported, false);
  assert.deepEqual(await f.provider.channels(), [{id:'2',name:'Telegram 用户 2',kind:'direct'},{id:'-1003',name:'Telegram 群 -1003',kind:'group'}]);
  for (const req of [{ kind:'group',targetId:'2' },{kind:'direct',targetId:'-1003'},{kind:'group',targetId:'-1003',media:'video'},{kind:'group',targetId:'-1003',inviteeIds:['2']}]) await assert.rejects(f.provider.dial(req as any), (e: any) => e.code === 'INVALID_REQUEST');
  assert.equal(f.fake.requests.length, 0);
  await f.provider.dial({ kind:'direct',targetId:'2',media:'video' });
  assert.deepEqual(f.fake.requests[0], ['dial',{kind:'direct',targetId:'2',media:'video'}]);
  await assert.rejects(f.provider.dial({kind:'group',targetId:'-1003'}), (e: any) => e.code === 'ACCOUNT_BUSY');
  assert.equal(f.fake.requests.some(([op]) => op === 'video.send'), false);
});

test('Telegram sends exact 10 ms frames with bounded queue and honest native-submit receipts', async t => {
  const f = await fixture({ maxQueueMs: 20 }); t.after(() => f.provider.stop()); f.connected();
  const queued = await f.provider.writeAudio(pcm(), 'audio1'); assert.equal(queued.state, 'queued'); assert.equal(queued.playedBytes, 0);
  await assert.rejects(f.provider.writeAudio(pcm(), 'audio2'), (e: any) => e.code === 'BACKPRESSURE');
  f.tick(); await pause(); f.tick(); await pause();
  const writes = f.fake.requests.filter(([op]) => op === 'audio.write'); assert.equal(writes.length, 2); assert.ok(writes.every(([,args]) => Buffer.from(args.data,'base64').length === 1920));
  const done = f.events.filter(e => e.type === 'playback').at(-1)!.playback!;
  assert.equal(done.state, 'dispatched'); assert.equal(done.dispatchedBytes, 3840); assert.equal(done.playedBytes, 0); assert.equal(done.evidence, 'ntgcalls-input-submit');
  await assert.rejects(f.provider.writeAudio(pcm(), 'audio1'), (e: any) => e.code === 'INVALID_PLAYBACK_ID');
});

test('clear cancels queued PCM, fences in-flight submission, and mute blocks new writes', async t => {
  const f = await fixture(); t.after(() => f.provider.stop()); f.connected();
  let resume!: () => void; f.fake.audioGate = new Promise(r => { resume = r; });
  await f.provider.writeAudio(pcm(), 'buffered'); f.tick(); await pause();
  const clearing = f.provider.clearAudio('tg:one'); await pause(); assert.equal(f.fake.requests.some(([op]) => op === 'audio.clear'), false);
  await assert.rejects(f.provider.writeAudio(pcm(), 'during-clear'), (e: any) => e.code === 'MUTED');
  resume(); await clearing; f.tick(); await pause(); assert.equal(f.fake.requests.filter(([op]) => op === 'audio.write').length, 1);
  const last = f.events.filter(e => e.type === 'playback').at(-1)!.playback!; assert.equal(last.state, 'cancelled'); assert.equal(last.dispatchedBytes, 1920); assert.equal(last.playedBytes, 0);
  await f.provider.setMuted('tg:one', true); await assert.rejects(f.provider.writeAudio(pcm(), 'muted'), (e: any) => e.code === 'MUTED');
});

test('Telegram real manager consumes only authorized decoded frames and clears both external outputs', async t => {
  const f = await fixture(), manager = new RtcManager(); t.after(() => manager.dispose()); await manager.register(f.provider); f.connected({...snap(),kind:'group',targetId:'-1003'});
  const owner = manager.controller('consumer'); owner.claim('tg:one');
  const track = await owner.subscribeVideo('tg:one', {kind:'camera',participantId:'2'}), reader = owner.video('tg:one',track.trackId)[Symbol.asyncIterator]();
  const pending = reader.next(); let got = false; void pending.then(() => { got = true; });
  const raw = {callId:'tg:one',trackId:track.trackId,participantId:'2',kind:'camera',encoding:'jpeg',width:2,height:2,sequence:0,timestamp:1,evidence:'ntgcalls-decoded-frame-and-jpeg-encode',data:Buffer.from([255,216,4,255,217]).toString('base64')};
  f.fake.emit({type:'video',frame:{...raw,participantId:'outsider'}}); f.fake.emit({type:'video',frame:{...raw,evidence:'just-captured'}}); await pause(); assert.equal(got,false);
  f.fake.emit({type:'video',frame:raw}); assert.equal((await pending).value?.evidence,raw.evidence);
  for (const kind of ['camera','screen'] as const) { await owner.sendVideo('tg:one',{kind,sourceId:'external-frames'}); const receipt = await owner.writeVideo('tg:one',{kind,encoding:'jpeg',width:2,height:2,sequence:0,timestamp:1,data:Buffer.from(raw.data,'base64')}); assert.equal(receipt.state,'submitted'); }
  assert.deepEqual(f.fake.requests.filter(([op])=>op==='video.send').map(([,a])=>a.kind),['camera','screen']);
  await owner.release('tg:one'); assert.deepEqual(f.fake.sending,{}); assert.equal(f.fake.tracks.length,0); assert.equal((await reader.next()).done,true);
});

test('offline fails current call, stops media and cannot resurrect terminal IDs or auto-redial', async t => {
  const f = await fixture(); t.after(() => f.provider.stop()); f.connected(); await f.provider.writeAudio(pcm(), 'old');
  f.fake.offline(); assert.equal(f.provider.calls()[0]?.state,'failed'); assert.equal(f.provider.capabilities().dial.supported,false); f.tick(); await pause(); assert.equal(f.fake.requests.length,0);
  f.fake.emit({type:'call',call:snap()}); assert.equal(f.provider.calls()[0]?.state,'failed');
  await assert.rejects(f.provider.dial({kind:'direct',targetId:'2'}),(e:any)=>e.code==='TELEGRAM_OFFLINE');
});

test('small consecutive PCM inputs share native 10 ms frames without padding gaps', async t => {
  const f = await fixture(); t.after(() => f.provider.stop()); f.connected();
  for (let i = 0; i < 3; i++) await f.provider.writeAudio({ ...pcm('tg:one', 640), data: new Uint8Array(640).fill(i + 1) }, `small-${i}`);
  f.tick(); await pause();
  const writes = f.fake.requests.filter(([op]) => op === 'audio.write'); assert.equal(writes.length, 1);
  const data = Buffer.from(writes[0]![1].data, 'base64');
  for (let i = 0; i < 3; i++) assert.ok(data.subarray(i * 640, (i + 1) * 640).every(value => value === i + 1));
  assert.equal(f.events.filter(e => e.playback?.state === 'dispatched').length, 3);
});

test('manager terminal cleanup is idempotent and emits no normal-hangup errors', async t => {
  const f = await fixture(), manager = new RtcManager(); t.after(() => manager.dispose()); const errors: string[] = [];
  manager.on('diagnostic', (value: any) => errors.push(String(value.error)));
  await manager.register(f.provider); f.connected(); const owner = manager.controller('terminal'); owner.claim('tg:one');
  await owner.subscribeVideo('tg:one', {kind:'camera',participantId:'2'});
  f.fake.emit({type:'call',call:{...snap(),state:'ended'}}); await pause(); await pause();
  await assert.doesNotReject(f.provider.clearAudio('tg:one')); await assert.doesNotReject(f.provider.clearVideo('tg:one'));
  assert.deepEqual(errors,[]); assert.equal(manager.listCalls()[0]?.state,'ended');
});

const nativePython = fileURLToPath(new URL('../runtime/telegram-venv/bin/python', import.meta.url));
test('real isolated Telegram sidecar refuses missing login before connecting and redacts credentials', { skip: !existsSync(nativePython), timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rtc-telegram-stdio-')); t.after(() => rm(directory,{recursive:true,force:true}));
  const configPath = join(directory,'config.json'), secret = 'abcdef0123456789abcdef0123456789';
  await writeFile(configPath,JSON.stringify({apiId:12345,apiHash:secret,selfId:'1',sessionPath:join(directory,'missing.session')}),{mode:0o600});
  const p = new TelegramProvider({...config,python:nativePython,configPath}); t.after(() => p.stop());
  await assert.rejects(p.start(),(e:any) => { assert.equal(e.code,'LOGIN_REQUIRED'); assert.equal(e.message.includes(secret),false); return true; });
  assert.deepEqual(p.calls(),[]); assert.equal(p.capabilities().dial.supported,false);
});

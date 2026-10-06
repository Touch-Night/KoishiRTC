import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DiscordProvider, type DiscordRuntime } from '../src/providers/discord.js';
import type { AudioFrame, ProviderEvent } from '../src/types.js';

class FakeVoice extends EventEmitter {
  state = { status: 'ready' }; destroyed = false; accepts = true; sent: Buffer[] = [];
  streams = new Map<string, PassThrough>(); speakingValues: boolean[] = [];
  receiver = {
    speaking: new EventEmitter(),
    subscribe: (id: string) => { const stream = new PassThrough({ objectMode: true }); this.streams.set(id, stream); return stream; },
  };
  playOpusPacket(packet: Buffer) { if (!this.accepts) return false; this.sent.push(Buffer.from(packet)); return true; }
  setSpeaking(value: boolean) { this.speakingValues.push(value); }
  destroy() { this.destroyed = true; this.change('destroyed'); }
  change(status: string) { const old = this.state; this.state = { status }; this.emit('stateChange', old, this.state); }
}
function setup(options: { guildIds?: string[]; selfId?: string; bot?: boolean; maxQueueMs?: number } = {}) {
  const voice = new FakeVoice(), events: ProviderEvent[] = [];
  const channel = { id: '200', guildId: '100', name: 'Voice', type: 2, members: new Map([['2', { id: '2', displayName: 'Alice' }]]), permissionsFor: () => ({ has: () => true }) };
  let fetches = 0, joins = 0, destroyedCodecs = 0;
  const signals: object[] = []; let adapter: { sendPayload(payload: object): boolean };
  const guild = { id: '100', name: 'Allowed', voiceAdapterCreator: () => ({ sendPayload: (payload: object) => { signals.push(payload); return true; }, destroy() {} }), members: { me: { id: '1', voice: { channelId: null as string | null } } }, channels: { fetch: async (id?: string) => { fetches++; return id ? channel : new Map([[channel.id, channel]]); } } };
  class FakeClient extends EventEmitter {
    user = { id: options.selfId ?? '1', bot: options.bot ?? true }; guilds = { cache: new Map([['100', guild]]) }; ready = false; destroyed = false;
    async login() { this.ready = true; this.emit('clientReady'); return 'secret'; }
    async destroy() { this.destroyed = true; this.ready = false; }
    isReady() { return this.ready; }
  }
  const client = new FakeClient(); let tick: (() => void) | undefined, timerStopped = false;
  const runtime = {
    client, join: (args: any) => { joins++; assert.equal(args.selfDeaf, false); assert.equal(args.selfMute, false); adapter = args.adapterCreator({}); return voice; },
    ready: async () => {}, receiveOptions: {},
    codec: () => {
      let deleted = false;
      return { encode: (data: Buffer, samples: number) => { assert.equal(samples, 960); assert.equal(data.length, 3840); return Buffer.from(data); }, decode: (data: Buffer) => Buffer.from(data), delete: () => { assert.equal(deleted, false, 'codec freed once'); deleted = true; destroyedCodecs++; } };
    },
  } as unknown as DiscordRuntime;
  const provider = new DiscordProvider({ id: 'discord-test', token: 'secret', selfId: '1', guildIds: options.guildIds ?? ['100'], maxQueueMs: options.maxQueueMs }, {
    load: async () => runtime,
    every: callback => { tick = callback; return () => { timerStopped = true; }; },
  });
  provider.events.on('event', event => events.push(event));
  const audio = (callId: string, bytes = 3840): AudioFrame => ({ callId, sampleRate: 48000, channels: 2, encoding: 'pcm_s16le', sequence: 0, timestamp: Date.now(), data: Buffer.alloc(bytes, 7) });
  return { provider, client, guild, channel, voice, events, audio, runtime, signals, signal: (payload: object) => adapter.sendPayload(payload), tick: () => tick?.(), fetches: () => fetches, joins: () => joins, timerStopped: () => timerStopped, destroyedCodecs: () => destroyedCodecs,
    join: () => provider.dial({ kind: 'group', guildId: '100', targetId: '200' }), receipts: () => events.flatMap(e => e.playback ? [e.playback] : []) };
}

test('Discord checks bot identity and defaults to an empty guild allowlist before fetching or joining', async () => {
  const denied = setup({ guildIds: [] }); await denied.provider.start();
  assert.equal(denied.provider.capabilities().joinGroup.supported, false);
  assert.deepEqual(await denied.provider.channels(), []);
  await assert.rejects(denied.join(), /白名单/); assert.equal(denied.fetches(), 0); assert.equal(denied.joins(), 0); await denied.provider.stop();
  for (const options of [{ selfId: '999' }, { bot: false }]) {
    const mismatch = setup(options); await assert.rejects(mismatch.provider.start(), /不一致/);
    assert.equal(mismatch.client.destroyed, true); assert.equal(mismatch.joins(), 0); assert.equal(mismatch.provider.capabilities().joinGroup.supported, false);
    assert.ok(mismatch.events.filter(e => e.type === 'availability').every(() => !mismatch.provider.capabilities().joinGroup.supported));
  }
});

test('Discord lists only ordinary permitted channels and refuses direct, foreign, Stage and busy calls', async () => {
  const f = setup(); await f.provider.start();
  assert.deepEqual(await f.provider.channels(), [{ id: '200', name: 'Voice', guildId: '100', guildName: 'Allowed' }]);
  await assert.rejects(f.provider.dial({ kind: 'direct', targetId: '2' }), /仅支持/);
  await assert.rejects(f.provider.dial({ kind: 'group', targetId: '200', guildId: '101' }), /白名单/);
  f.channel.type = 13; await assert.rejects(f.join(), /Stage/); f.channel.type = 2;
  f.channel.permissionsFor = () => ({ has: () => false }); await assert.rejects(f.join(), /权限/); f.channel.permissionsFor = () => ({ has: () => true });
  f.guild.members.me.voice.channelId = '300'; await assert.rejects(f.join(), /接管/); f.guild.members.me.voice.channelId = null;
  const call = await f.join(); assert.equal(call.state, 'connected'); assert.equal(f.provider.capabilities().dial.supported, false);
  await assert.rejects(f.join(), /正在进行/); await f.provider.hangup(call.id); assert.equal(f.voice.destroyed, true); await f.provider.stop();
});

test('Discord waits for guild readiness after login and does not expose audio capabilities early', async () => {
  const f = setup(); let release!: () => void;
  f.client.login = async () => { release = () => { f.client.ready = true; f.client.emit('clientReady'); }; return 'secret'; };
  const starting = f.provider.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.provider.capabilities().joinGroup.supported, false); assert.equal(f.joins(), 0);
  release(); await starting; assert.equal(f.provider.capabilities().joinGroup.supported, true); await f.provider.stop();
});

test('Discord bounded PCM dispatch reports actual local transmission separately from playback and clears exact remaining prefix', async () => {
  const f = setup({ maxQueueMs: 40 }); await f.provider.start(); const call = await f.join();
  const initial = await f.provider.writeAudio(f.audio(call.id, 7680), 'a');
  assert.equal(initial.state, 'queued'); assert.equal(initial.playedBytes, 0); assert.equal(initial.dispatchedBytes, 0); assert.equal(f.voice.sent.length, 0);
  await assert.rejects(f.provider.writeAudio(f.audio(call.id), 'full'), /队列已满/);
  f.tick(); const partial = f.receipts().at(-1)!; assert.equal(partial.state, 'playing'); assert.equal(partial.dispatchedBytes, 3840); assert.equal(partial.playedBytes, 0);
  await f.provider.clearAudio(call.id); const cancelled = f.receipts().at(-1)!; assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.dispatchedBytes, 3840);
  await assert.rejects(f.provider.writeAudio(f.audio(call.id), 'a'), /ID/);
  await f.provider.writeAudio(f.audio(call.id, 1920), 'b'); await f.provider.writeAudio(f.audio(call.id, 1920), 'c'); f.tick();
  const completed = f.receipts().filter(r => r.state === 'dispatched'); assert.deepEqual(completed.map(r => r.id), ['b', 'c']);
  assert.ok(completed.every(r => r.playedBytes === 0 && r.dispatchedBytes === 1920 && r.evidence === 'discord-udp-dispatch'));
  for (let i = 0; i < 5; i++) f.tick(); assert.equal(f.voice.speakingValues.at(-1), false);
  await f.provider.stop();
});

test('Discord format validation, mute and transport failure never dispatch a rejected or cancelled PCM frame', async () => {
  const f = setup(); await f.provider.start(); const call = await f.join();
  await assert.rejects(f.provider.writeAudio({ ...f.audio(call.id), sampleRate: 24000 }, 'bad'), /48 kHz/);
  await f.provider.writeAudio(f.audio(call.id), 'cancel'); await f.provider.setMuted(call.id, true); f.tick();
  assert.equal(f.voice.sent.length, 0); assert.equal(f.receipts().at(-1)!.state, 'cancelled');
  await assert.rejects(f.provider.writeAudio(f.audio(call.id), 'muted'), /静音/);
  await f.provider.setMuted(call.id, false); await f.provider.writeAudio(f.audio(call.id), 'fail'); f.voice.accepts = false; f.tick();
  assert.equal(f.receipts().at(-1)!.state, 'failed'); assert.equal(f.receipts().at(-1)!.dispatchedBytes, 0);
  assert.equal(f.provider.calls().at(-1)!.state, 'failed'); assert.equal(f.timerStopped(), true); await f.provider.stop();
});

test('Discord receive keeps simultaneous speakers separate, advances per-user sequence across speech bursts and frees streams', async () => {
  const f = setup(); await f.provider.start(); const call = await f.join();
  f.voice.receiver.speaking.emit('start', '2'); f.voice.receiver.speaking.emit('start', '3'); f.voice.receiver.speaking.emit('start', '1');
  assert.equal(f.voice.streams.has('1'), false);
  f.voice.streams.get('2')!.write(Buffer.alloc(3840, 2)); f.voice.streams.get('3')!.write(Buffer.alloc(7680, 3));
  const frames = () => f.events.flatMap(e => e.audio ? [e.audio] : []);
  assert.deepEqual(frames().map(a => [a.speakerId, a.sequence]), [['2', 0], ['3', 0], ['3', 1]]);
  assert.ok(frames().every(a => a.callId === call.id && a.sampleRate === 48000 && a.channels === 2 && a.data.length === 3840));
  assert.equal(frames()[0]!.data[0], 2); assert.equal(frames()[1]!.data[0], 3);
  f.voice.streams.get('2')!.end(); await new Promise(resolve => setImmediate(resolve));
  f.voice.receiver.speaking.emit('start', '2'); f.voice.streams.get('2')!.write(Buffer.alloc(3840, 4));
  assert.equal(frames().at(-1)!.sequence, 1); assert.equal(f.provider.calls()[0]!.participants.find(p => p.id === '3')!.identity, 'platform');
  const stream = f.voice.streams.get('2')!; await f.provider.hangup(call.id); assert.equal(stream.destroyed, true); assert.equal(f.voice.receiver.speaking.listenerCount('start'), 0);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.destroyedCodecs(), 5); await f.provider.stop();
});

test('Discord disconnect, gateway loss and external channel movement release all resources without rejoin', async () => {
  for (const kind of ['voice', 'gateway', 'move']) {
    const f = setup(); await f.provider.start(); const call = await f.join(); await f.provider.writeAudio(f.audio(call.id), 'pending');
    if (kind === 'voice') {
      f.voice.change('signalling');
      assert.equal(f.signal({ d: { channel_id: '200' } }), false, 'SDK automatic rejoin must be blocked before destruction');
      assert.equal(f.signal({ d: { channel_id: null } }), true, 'leaving remains allowed');
      await new Promise(resolve => queueMicrotask(resolve));
    }
    if (kind === 'gateway') f.client.emit('shardDisconnect');
    if (kind === 'move') f.client.emit('voiceStateUpdate', { channelId: '200' }, { id: '1', guild: { id: '100' }, channelId: '300' });
    assert.equal(f.provider.calls()[0]!.state, 'failed'); assert.equal(f.voice.destroyed, true); assert.equal(f.receipts().at(-1)!.state, 'failed');
    f.tick(); assert.equal(f.voice.sent.length, 0); assert.equal(f.joins(), 1); await f.provider.stop();
  }
});

test('Discord abort during channel lookup prevents a late join, and connecting hangup cancels readiness', async () => {
  const f = setup(); await f.provider.start(); let lookup!: (value: any) => void;
  f.guild.channels.fetch = () => new Promise(resolve => { lookup = resolve; });
  const abort = new AbortController(); const joining = f.provider.dial({ kind: 'group', guildId: '100', targetId: '200' }, abort.signal);
  abort.abort(new Error('aborted')); await assert.rejects(joining, /aborted/); lookup(f.channel); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.joins(), 0); await f.provider.stop();
  const g = setup(); await g.provider.start();
  g.runtime.ready = (_voice, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  const pending = g.join(); await new Promise(resolve => setImmediate(resolve));
  await g.provider.hangup(g.provider.calls()[0]!.id); await assert.rejects(pending, /结束/); assert.equal(g.provider.calls()[0]!.state, 'ended'); await g.provider.stop();
});

test('installed Opus codec performs 48 kHz stereo encode/decode entirely offline', async () => {
  const { default: Opus } = await import('opusscript');
  const encoder = new Opus(48000, 2, Opus.Application.AUDIO), decoder = new Opus(48000, 2, Opus.Application.AUDIO);
  try { const packet = encoder.encode(Buffer.alloc(3840), 960); const pcm = decoder.decode(packet); assert.equal(pcm.length, 3840); }
  finally { encoder.delete(); decoder.delete(); }
});

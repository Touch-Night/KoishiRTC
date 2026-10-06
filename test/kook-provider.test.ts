import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { KookProvider, rtcpSenderReport } from '../src/providers/kook.js';
import type { ProviderEvent } from '../src/types.js';

async function setup(options: { channelIds?: string[]; identity?: string; busy?: boolean; badParams?: boolean } = {}) {
  const receiver = createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const packets: Buffer[] = []; receiver.on('message', p => packets.push(p));
  const requests: Array<{ route: string; body: any }> = [], events: ProviderEvent[] = [], timers = new Map<number, () => void>();
  let failLeave = false;
  const provider = new KookProvider({ id: 'kook-test', token: 'private-token', selfId: '123', channelIds: options.channelIds ?? ['456'], maxQueueMs: 40 }, {
    fetch: (async (url: string | URL | Request, init: RequestInit) => {
      assert.equal((init.headers as any).Authorization, 'Bot private-token');
      const route = String(url).split('/v3/')[1]!, body = init.body ? JSON.parse(String(init.body)) : undefined; requests.push({ route, body });
      let data: unknown = {};
      if (route === 'user/me') data = { id: options.identity ?? '123', bot: true };
      if (route === 'voice/list') data = { items: options.busy ? [{ id: '999' }] : [] };
      if (route.startsWith('channel/view')) data = { id: '456', name: 'test', type: 2, guild_id: '77' };
      if (route === 'voice/join') data = { ip: '127.0.0.1', port: (receiver.address() as any).port, rtcp_mux: true, audio_ssrc: '1111', audio_pt: '111', bitrate: options.badParams ? 0 : 48000 };
      if (route === 'voice/leave' && failLeave) throw new Error('network unavailable');
      return new Response(JSON.stringify({ code: 0, data }));
    }) as typeof fetch,
    every: (fn, ms) => { timers.set(ms, fn); return () => timers.delete(ms); },
  });
  provider.events.on('event', e => events.push(e));
  const audio = (callId: string, length = 3840) => ({ callId, encoding: 'pcm_s16le' as const, sampleRate: 48000, channels: 2 as const, sequence: 0, timestamp: Date.now(), data: Buffer.alloc(length) });
  return { provider, events, requests, timers, packets, audio, failLeave: (v: boolean) => { failLeave = v; }, tick: async () => { timers.get(20)?.(); await new Promise(r => setTimeout(r, 15)); }, join: () => provider.dial({ kind: 'group', targetId: '456' }), dispose: async () => { failLeave = false; await provider.stop(); receiver.close(); } };
}
test('KOOK identity and allowlist protect calls; receive capabilities are never fabricated', async () => {
  const f = await setup({ channelIds: [] }); try { await f.provider.start(); assert.equal(f.provider.capabilities().joinGroup.supported, false); assert.equal(f.provider.capabilities().receiveAudio.supported, false); await assert.rejects(f.join(), /白名单/); assert.equal(f.requests.some(r => r.route === 'voice/join'), false); } finally { await f.dispose(); }
  const g = await setup({ identity: '999' }); try { await assert.rejects(g.provider.start(), /不一致/); } finally { await g.dispose(); }
});
test('KOOK lists allowed channels and refuses stealing an existing server connection', async () => {
  const f = await setup({ busy: true }); try { await f.provider.start(); assert.deepEqual(await f.provider.channels(), [{ id: '456', name: 'test', guildId: '77' }]); await assert.rejects(f.join(), /其他应用/); await assert.rejects(f.provider.dial({ kind: 'direct', targetId: '456' }), /仅支持/); } finally { await f.dispose(); }
});
test('KOOK sends real decodable Opus/RTP, tracks dispatch separately from playback and emits SR+SDES', async () => {
  const f = await setup(); try {
    await f.provider.start(); const call = await f.join(); assert.equal(call.state, 'connected');
    const receipt = await f.provider.writeAudio(f.audio(call.id, 7680), 'audio'); assert.equal(receipt.state, 'queued');
    await assert.rejects(f.provider.writeAudio(f.audio(call.id), 'overflow'), /队列已满/);
    await f.tick(); await f.tick();
    const rtp = f.packets.filter(p => p[1] === 111); assert.equal(rtp.length, 2); assert.equal(rtp[0]![0], 0x80); assert.equal(rtp[0]!.readUInt32BE(8), 1111);
    assert.equal((rtp[1]!.readUInt16BE(2) - rtp[0]!.readUInt16BE(2)) & 65535, 1); assert.equal((rtp[1]!.readUInt32BE(4) - rtp[0]!.readUInt32BE(4)) >>> 0, 960);
    const { default: Opus } = await import('opusscript'); const decoder = new Opus(48000, 2, Opus.Application.AUDIO);
    try { assert.equal(decoder.decode(rtp[0]!.subarray(12)).length, 3840); } finally { decoder.delete(); }
    const done = f.events.flatMap(e => e.playback ? [e.playback] : []).at(-1)!; assert.equal(done.state, 'dispatched'); assert.equal(done.dispatchedBytes, 7680); assert.equal(done.playedBytes, 0);
    assert.ok(f.packets.some(p => p[1] === 200 && p[29] === 202));
    f.timers.get(40000)?.(); await new Promise(r => setImmediate(r)); assert.ok(f.requests.some(r => r.route === 'voice/keep-alive'));
    await f.provider.hangup(call.id); assert.equal(f.provider.calls().at(-1)!.state, 'ended'); assert.equal(f.timers.size, 0);
  } finally { await f.dispose(); }
});
test('KOOK clear/mute never replays pending audio and unknown leave keeps the call occupied', async () => {
  const f = await setup(); try { await f.provider.start(); const call = await f.join(); await f.provider.writeAudio(f.audio(call.id), 'cancel'); await f.provider.setMuted(call.id, true); await f.tick(); assert.equal(f.packets.length, 0); await assert.rejects(f.provider.writeAudio(f.audio(call.id), 'mute'), /静音/);
    f.failLeave(true); await assert.rejects(f.provider.hangup(call.id), /network/); assert.equal(f.provider.calls().at(-1)!.state, 'ending'); await assert.rejects(f.join(), /正在进行/); f.failLeave(false); await f.provider.hangup(call.id); assert.equal(f.provider.calls().at(-1)!.state, 'ended');
  } finally { await f.dispose(); }
});
test('KOOK invalid negotiated RTP parameters are rejected and allocated room is released', async () => {
  const f = await setup({ badParams: true }); try { await f.provider.start(); await assert.rejects(f.join(), /RTP/); assert.ok(f.requests.some(r => r.route === 'voice/leave')); assert.equal(f.timers.size, 0); } finally { await f.dispose(); }
});
test('RTCP compound packet encodes exact count, timestamp and a padded CNAME chunk', () => {
  const data = rtcpSenderReport(1111, 1234, 2, 240, 1700000000123); assert.equal(data.readUInt32BE(4), 1111); assert.equal(data.readUInt32BE(16), 1234); assert.equal(data.readUInt32BE(20), 2); assert.equal(data.readUInt32BE(24), 240); assert.equal(data.length % 4, 0); assert.equal(data.readUInt16BE(30) * 4 + 4, data.length - 28);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { RtcManager, unavailableCapabilities } from '../src/core.js';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
// @ts-expect-error standalone bridge JavaScript
import { createDaemon, QqControl } from '../bridge/daemon.mjs';
const token = 'fixture-transition-token-'.repeat(3);
const delay = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await delay(); assert.ok(check(), 'condition timed out'); }
async function fixture() {
  const requests: any[] = [], outputs: any = {}, cancelled = new Set<string>(); let identity = 'self', compact = false, pending: { requestId: string; res: http.ServerResponse } | undefined;
  const server = http.createServer(async(req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url!, 'http://fixture'); requests.push({ path: url.pathname, query: url.searchParams.toString(), body });
    const ok = (data: any) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
    const state = () => ({ supported: true, sessionId: 'native', tracks: [], sending: { ...outputs } });
    if (url.pathname === '/v1/capabilities') return ok({ selfId: identity, bootId: 'boot', capabilities: {} });
    if (url.pathname === '/v1/video/sources') return ok(compact ? [{ id: 'shared-source', name: 'Shared generated source', kind: 'screen', sourceType: 'generated', channels: ['camera', 'screen'] }] : ['camera', 'screen'].map(kind => ({ id: `generated-${kind}`, name: `Generated ${kind}`, kind, sourceType: 'generated' })));
    if (url.pathname === '/v1/video/state') return ok(state());
    if (url.pathname === '/v1/video/send') {
      if (cancelled.has(body.requestId)) { res.end(JSON.stringify({ ok: false, error: { code: 'SCREEN_UPGRADE_CANCELLED', message: 'cancelled before send arrived' } })); return; }
      if (body.kind === 'camera') { outputs.camera = { sourceId: body.sourceId, state: 'sending' }; return ok(state()); }
      pending = { requestId: body.requestId, res }; return;
    }
    if (url.pathname === '/v1/video/cancel') {
      cancelled.add(body.targetRequestId);
      if (pending?.requestId === body.targetRequestId) {
        pending.res.setHeader('Content-Type', 'application/json'); pending.res.end(JSON.stringify({ ok: false, error: { code: 'SCREEN_UPGRADE_CANCELLED', message: 'fixture cancelled exactly this upgrade' } })); pending = undefined;
      }
      return ok(state());
    }
    if (url.pathname === '/v1/video/stop') { delete outputs[body.kind]; return ok(state()); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const control = new QqControl({ url: `http://127.0.0.1:${(server.address() as any).port}`, token, selfId: 'self' });
  control.start = async () => {}; control.stopped = false; control.offline = false; control.bootId = 'boot';
  control.caps = Object.fromEntries(Object.keys(unavailableCapabilities()).map(k => [k, { supported: true }]));
  const audio: any = new EventEmitter(); let running = false, writes = 0; const mutes: boolean[] = [];
  audio.config = { sampleRate: 48000, channels: 1 }; audio.diagnostics = async () => []; audio.listDevices = async () => [];
  audio.start = async () => { running = true; }; audio.stop = async () => { running = false; }; audio.clear = async () => {};
  audio.setMuted = async (value: boolean) => { mutes.push(value); }; audio.write = async (data: Buffer, id: string) => { writes++; return { id, state: 'queued', acceptedBytes: data.length, playedBytes: 0 }; };
  const daemon = await createDaemon({ host: '127.0.0.1', port: 0, token, account: { platform: 'onebot', selfId: 'self' }, audio: audio.config }, { control, audio });
  const addr = await daemon.start(), manager = new RtcManager();
  const provider = new DesktopBridgeProvider({ id: 'desktop', selfId: 'self', platform: 'onebot', token, url: `ws://127.0.0.1:${addr.port}/v1/stream` });
  await manager.register(provider); await until(() => provider.capabilities().sendAudio.supported);
  const native = { id: 'native', kind: 'private', direction: 'outgoing', phase: 'connected', peerUid: 'peer', nativeSceneId: 1, participants: [] };
  const connect = async () => { control.ingest(native); await until(() => manager.listCalls().length === 1 && running); const call = manager.listCalls()[0]!; const owner = manager.controller('consumer'); owner.claim(call.id); return { call, owner }; };
  return { manager, provider, control, requests, mutes, connect, native, audio,
    running: () => running, writes: () => writes, pending: () => pending, changeIdentity(value: string) { identity = value; }, useCompactSources() { compact = true; },
    close: async () => { await manager.dispose(); await daemon.stop(); if (pending) { pending.res.end('{}'); pending = undefined; } server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}
const pcm = { encoding: 'pcm_s16le' as const, sampleRate: 48000, channels: 1 as const, data: Buffer.alloc(1920), timestamp: 1, sequence: 0 };

test('pre-call sources cross real provider/daemon/QQ HTTP without creating a call or opening audio', async t => {
  const f = await fixture(); t.after(f.close);
  const sources = await f.manager.availableVideoSources('desktop');
  assert.deepEqual(sources.map(s => s.id), ['generated-camera', 'generated-screen']);
  assert.deepEqual(f.manager.listCalls(), []); assert.equal(f.running(), false);
  assert.ok(f.requests.some(r => r.path === '/v1/video/sources' && r.query === '' && r.body === undefined));
  assert.equal(f.requests.some(r => r.body), false, 'no session or mutation POST while browsing');
  f.changeIdentity('other-account'); const reads = f.requests.filter(r => r.path === '/v1/video/sources').length;
  await assert.rejects(f.manager.availableVideoSources('desktop'), (e: any) => e.code === 'ACCOUNT_MISMATCH');
  assert.equal(f.requests.filter(r => r.path === '/v1/video/sources').length, reads);
});

test('transition crosses QQ/provider/core; writes fail closed while mute persists into restored audio', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  const startedAt = '2026-10-06T07:00:00.000Z';
  for (const status of ['preparing', 'closing', 'negotiating', 'connecting', 'restoring', 'failed', 'cancelled']) {
    f.control.ingest({ ...f.native, mediaTransition: { kind: 'screen', status, interruption: true, startedAt, requestId: 'upgrade-1', error: status === 'failed' ? 'fixture failure' : undefined } });
    await until(() => f.manager.getCall(call.id).mediaTransition?.status === status);
    assert.equal(f.manager.getCall(call.id).mediaTransition?.startedAt, Date.parse(startedAt));
    await assert.rejects(owner.writeAudio(call.id, pcm), (e: any) => e.code === 'MEDIA_TRANSITION');
    await assert.rejects(f.provider.writeAudio({ ...pcm, callId: call.id }, 'direct'), (e: any) => e.code === 'MEDIA_TRANSITION');
    await assert.rejects((f.provider as any).request('audio.write', { frame: { ...pcm, callId: 'boot:0:native', data: pcm.data.toString('base64') }, playbackId: 'raw' }), (e: any) => e.code === 'MEDIA_TRANSITION');
  }
  assert.equal(f.writes(), 0); await until(() => !f.running()); await owner.setMuted(call.id, true);
  f.control.ingest({ ...f.native, mediaTransition: { kind: 'screen', status: 'completed', interruption: true, startedAt, finishedAt: '2026-10-06T07:00:02.000Z', requestId: 'upgrade-1' } });
  await until(() => f.manager.getCall(call.id).mediaTransition?.status === 'completed' && f.running());
  assert.equal(f.manager.getCall(call.id).muted, true); assert.equal(f.mutes.at(-1), true);
  await assert.rejects(owner.writeAudio(call.id, pcm), (e: any) => e.code === 'MUTED');
  await owner.setMuted(call.id, false); await owner.writeAudio(call.id, pcm); assert.equal(f.writes(), 1);
});

test('screen stop cancels the exact pending send through both serial queues before cleanup', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  const pending = owner.sendVideo(call.id, { kind: 'screen', sourceId: 'generated-screen' });
  const rejected = assert.rejects(pending, (e: any) => e.code === 'SCREEN_UPGRADE_CANCELLED'); await until(() => !!f.pending());
  const target = f.pending()!.requestId;
  await (f.provider as any).request('video.cancel', { callId: 'boot:0:native', targetRequestId: 'old-request' });
  assert.equal(f.pending()?.requestId, target, 'stale cancel cannot affect this send');
  await owner.stopVideo(call.id, 'screen'); await rejected;
  const cancel = f.requests.findIndex(r => r.path === '/v1/video/cancel' && r.body.targetRequestId === target), stop = f.requests.findIndex(r => r.path === '/v1/video/stop');
  assert.ok(cancel >= 0 && stop > cancel, 'cancel reaches native before the queued stop');
  assert.equal(f.manager.getCall(call.id).state, 'connected');
});

test('controller release cancels a pending screen upgrade without waiting for its send reply', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  const pending = owner.sendVideo(call.id, { kind: 'screen', sourceId: 'generated-screen' }); const rejected = assert.rejects(pending);
  await until(() => !!f.pending()); await owner.release(call.id); await rejected;
  assert.equal(f.pending(), undefined); assert.equal(f.manager.getCall(call.id).owner, undefined);
});

test('owner socket disconnect cancels its reserved native request, independently of provider callbacks', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  const pending = owner.sendVideo(call.id, { kind: 'screen', sourceId: 'generated-screen' }); const rejected = assert.rejects(pending);
  await until(() => !!f.pending()); const target = f.pending()!.requestId; await f.provider.stop(); await rejected;
  await until(() => !f.pending()); assert.ok(f.requests.some(r => r.path === '/v1/video/cancel' && r.body.targetRequestId === target));
});

test('malformed transition cannot be downgraded into an apparently safe audio call', async t => {
  const f = await fixture(); t.after(f.close); await f.connect();
  assert.throws(() => f.control.ingest({ ...f.native, mediaTransition: { kind: 'screen', status: 'typo', startedAt: 1, interruption: true } }), (e: any) => e.code === 'INVALID_STATUS');
});

test('compact multi-channel sources permit camera across manager/provider/daemon/QQ transport', async t => {
  const f = await fixture(); t.after(f.close); f.useCompactSources(); const { call, owner } = await f.connect();
  const sources = await f.manager.availableVideoSources('desktop'); assert.deepEqual(sources[0].channels, ['camera', 'screen']);
  const result = await owner.sendVideo(call.id, { kind: 'camera', sourceId: 'shared-source' });
  assert.equal(result.sending.camera?.state, 'sending'); assert.equal(result.sending.camera?.sourceId, 'shared-source');
});

test('failed/cancelled video restoration resumes voice only with explicit audioReady evidence', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  for (const status of ['failed', 'cancelled']) {
    const transition = { kind: 'screen', status, interruption: true, startedAt: new Date().toISOString(), error: 'video restore failed' };
    f.control.ingest({ ...f.native, mediaTransition: { ...transition, audioReady: false } });
    await until(() => f.manager.getCall(call.id).mediaTransition?.status === status && !f.running());
    await assert.rejects(owner.writeAudio(call.id, pcm), (e: any) => e.code === 'MEDIA_TRANSITION');
    f.control.ingest({ ...f.native, mediaTransition: { ...transition, audioReady: true } });
    await until(() => f.manager.getCall(call.id).mediaTransition?.audioReady === true && f.running());
    await owner.writeAudio(call.id, pcm);
  }
  assert.equal(f.writes(), 2);
});

test('cancellation can arrive before native send and retains the exact original request scope', async t => {
  const f = await fixture(); t.after(f.close); const { call, owner } = await f.connect();
  let resume!: () => void, entered = false; const gate = new Promise<void>(r => resume = r), request = f.control.request.bind(f.control);
  f.control.request = async (route: string, ...args: any[]) => { if (route === '/v1/video/send') { entered = true; await gate; } return request(route, ...args); };
  const sending = owner.sendVideo(call.id, { kind: 'screen', sourceId: 'generated-screen' });
  const rejected = assert.rejects(sending, (e: any) => e.code === 'SCREEN_UPGRADE_CANCELLED'); await until(() => entered);
  const stopped = owner.stopVideo(call.id, 'screen'); await until(() => f.requests.some(r => r.path === '/v1/video/cancel'));
  assert.equal(f.requests.some(r => r.path === '/v1/video/send'), false); resume(); await rejected; await stopped;
  const cancel = f.requests.find(r => r.path === '/v1/video/cancel'), send = f.requests.find(r => r.path === '/v1/video/send');
  assert.equal(cancel.body.targetRequestId, send.body.requestId); assert.equal(f.pending(), undefined);
});

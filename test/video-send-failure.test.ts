import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DesktopBridgeProvider } from '../src/providers/bridge.js';
import { readVideoSendFailure, unavailableCapabilities } from '../src/types.js';
// @ts-expect-error standalone JavaScript
import { createDaemon, QqControl, readVideoSendFailure as readDaemonProof } from '../bridge/daemon.mjs';
// @ts-expect-error standalone JavaScript
import { createHttpServer, createHostTransport, readVideoSendFailure as readHttpProof } from '../bridge/qq/napcat-plugin/http.mjs';
const token = 'failure-proof-fixture-'.repeat(4);
const expected = { requestId: 'request-1', callId: 'call', kind: 'screen' as const, sourceId: 'generated' };
const delay = (ms = 5) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await delay(); assert.ok(check()); }
async function listen(server: http.Server) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return (server.address() as any).port as number; }
async function close(server: http.Server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }

test('failure validators accept only matching whitelisted evidence, never a code or another channel', () => {
  for (const read of [readVideoSendFailure, readDaemonProof, readHttpProof]) {
    for (const outcome of ['unchanged', 'stopped']) {
      const value = { ...expected, outcome, secret: 'do not forward' };
      assert.deepEqual(read(value, expected), { ...expected, outcome });
    }
    for (const patch of [{ requestId: 'other' }, { callId: 'other' }, { kind: 'camera' }, { sourceId: 'other' }, { outcome: 'unknown' }, { outcome: 'unchanged; retry' }, { requestId: '' }]) {
      assert.equal(read({ ...expected, outcome: 'unchanged', ...patch }, expected), undefined);
    }
    assert.equal(read({ code: 'INVALID_SOURCE' }, expected), undefined);
    assert.equal(read(undefined, expected), undefined);
  }
});

test('matching failure evidence survives HTTP/QQ/daemon/WebSocket and remaps call ids; mismatches and lost responses do not', async t => {
  let patch: any = {}, loseReply = false; const attempts: any[] = [];
  const host = http.createServer(async(req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    res.setHeader('Content-Type', 'application/json');
    const route = new URL(req.url!, 'http://fixture').pathname;
    if (route === '/v1/video/sources') { res.end(JSON.stringify({ code: 0, data: [{ id: 'generated', name: 'Generated fixture', kind: 'screen', sourceType: 'generated' }] })); return; }
    if (route === '/v1/video/state' || route === '/v1/video/stop') { res.end(JSON.stringify({ code: 0, data: { supported: true, sessionId: 'native', tracks: [], sending: {} } })); return; }
    assert.equal(route, '/v1/video/send'); attempts.push(body);
    if (loseReply) { req.socket.destroy(); return; }
    const proof = { requestId: body.requestId, callId: body.callId, kind: body.kind, sourceId: body.sourceId, outcome: 'unchanged', extra: 'strip me', ...patch };
    res.writeHead(409); res.end(JSON.stringify({ code: -1, errorCode: 'INVALID_SOURCE', message: 'fixture source unavailable', videoSendFailure: proof }));
  });
  const hostPort = await listen(host), transport = createHostTransport({ avHost: '127.0.0.1', avPort: hostPort }, token);
  const native = createHttpServer({ probe: async () => ({ selfId: 'self', bootId: 'boot' }), video: async (op: string, body: any) => {
    if (op === 'sources') return transport.hostRequest('/v1/video/sources');
    return transport.hostRequest(`/v1/video/${op}`, body);
  } }, token);
  const nativePort = await listen(native), control = new QqControl({ url: `http://127.0.0.1:${nativePort}`, token, selfId: 'self' });
  control.start = async () => {}; control.stopped = false; control.offline = false; control.bootId = 'boot';
  control.caps = Object.fromEntries(Object.keys(unavailableCapabilities()).map(k => [k, { supported: true }]));
  control.ingest({ id: 'native', kind: 'private', direction: 'outgoing', phase: 'connected', peerUid: 'peer', nativeSceneId: 2, participants: [] });
  const audio: any = new EventEmitter(); audio.config = { sampleRate: 48000, channels: 1 }; audio.diagnostics = async () => []; audio.start = async () => {}; audio.stop = async () => {}; audio.setMuted = async () => {}; audio.clear = async () => {};
  const daemon = await createDaemon({ host: '127.0.0.1', port: 0, token, account: { platform: 'onebot', selfId: 'self' }, audio: audio.config }, { control, audio });
  const address = await daemon.start(), provider = new DesktopBridgeProvider({ id: 'desktop', token, selfId: 'self', url: `ws://127.0.0.1:${address.port}/v1/stream` });
  t.after(async () => { await provider.stop(); await daemon.stop(); await close(native); await close(host); });
  await provider.start(); await until(() => provider.calls().length === 1);
  const call = provider.calls()[0]!;
  for (const outcome of ['unchanged', 'stopped']) {
    patch = { outcome };
    await assert.rejects(provider.sendVideo(call.id, { kind: 'screen', sourceId: 'generated' }), (error: any) => {
      assert.equal(error.code, 'INVALID_SOURCE');
      assert.deepEqual(error.videoSendFailure, { requestId: attempts.at(-1).requestId, callId: call.id, kind: 'screen', sourceId: 'generated', outcome }); return true;
    });
    await provider.clearVideo(call.id);
  }
  for (const invalid of [{ requestId: 'unrelated' }, { callId: 'other-call' }, { kind: 'camera' }, { sourceId: 'other-source' }, { outcome: 'unknown' }]) {
    patch = invalid;
    await assert.rejects(provider.sendVideo(call.id, { kind: 'screen', sourceId: 'generated' }), (error: any) => { assert.equal(error.videoSendFailure, undefined); return true; });
    await provider.clearVideo(call.id);
  }
  patch = {}; loseReply = true;
  await assert.rejects(provider.sendVideo(call.id, { kind: 'screen', sourceId: 'generated' }), (error: any) => { assert.equal(error.code, 'AV_HOST_UNAVAILABLE'); assert.equal(error.videoSendFailure, undefined); return true; });
  await provider.clearVideo(call.id);
});

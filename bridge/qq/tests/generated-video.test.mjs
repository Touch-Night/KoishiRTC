import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { VideoHost } = createRequire(import.meta.url)('../av-host/video.cjs');
async function fixture({ cameraAvailable = true, screenAvailable = true } = {}) {
  const sent = [], opened = [], closed = [];
  const outputs = {
    cameraAvailable: () => cameraAvailable,
    open: async (kind, callId, options) => { opened.push({ kind, callId, options }); return { nativeDeviceId: 'virtual-id', handle: 43 }; },
    close: async kind => { closed.push(kind); },
  };
  const host = new VideoHost({ enabled: true, outputBackend: outputs,
    testWindow: screenAvailable ? async () => 42 : undefined, surface: async () => {}, capture: async () => {},
    send: async (cmd, args, id) => {
      sent.push([cmd, args]);
      if (id) queueMicrotask(() => host.handle({ cmd, id, value: cmd === 46 ? [0, '', ['Physical', 'Virtual'], ['physical-id', 'virtual-id']] : [0, ''] }));
    },
  });
  await host.session({ callId: 'a', selfUid: 'self', nativeSceneId: 1, participants: ['peer'] });
  return { host, outputs, sent, opened, closed };
}

test('test-pattern enumerates only available safe generated channels', async () => {
  for (const [cameraAvailable, screenAvailable, expected] of [[true, true, ['screen', 'camera']], [false, true, ['screen']], [true, false, ['camera']], [false, false, []]]) {
    const { host } = await fixture({ cameraAvailable, screenAvailable });
    const sources = await host.sources({ callId: 'a' });
    const generated = sources.filter(source => source.id === 'test-pattern');
    assert.deepEqual(generated.map(source => source.kind), expected);
    assert.ok(generated.every(source => source.sourceType === 'generated' && /测试/.test(source.name)));
    assert.ok(sources.filter(source => source.id === 'external-frames').every(source => source.sourceType === 'frames'));
    await host.clear();
  }
});

test('generated camera starts its verified virtual device and never opens the first physical camera', async () => {
  const f = await fixture(); await f.host.sources({ callId: 'a' }); f.sent.length = 0;
  await f.host.startSend({ callId: 'a', kind: 'camera', sourceId: 'test-pattern' });
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0].options.generated, true);
  assert.equal(f.opened[0].options.framing, undefined);
  assert.deepEqual(f.sent.map(([cmd]) => cmd), [49, 46, 47, 48, 30]);
  assert.deepEqual(f.sent.find(([cmd]) => cmd === 47)[1], ['virtual-id', true, true]);
  assert.equal(f.host.state().sending.camera.state, 'sending');
  assert.equal(f.host.frameChannels.has('camera'), false, 'a generated source never becomes an external-frame writable channel');
  await f.host.startSend({ callId: 'a', kind: 'camera', sourceId: 'test-pattern' }); assert.equal(f.opened.length, 1);
  await f.host.clear();
});

test('a running generated-camera failure truthfully fails the channel and stops native capture', async () => {
  const f = await fixture(); await f.host.sources({ callId: 'a' });
  await f.host.startSend({ callId: 'a', kind: 'camera', sourceId: 'test-pattern' }); f.sent.length = 0;
  f.opened[0].options.onError(new Error('generated capture timed out'));
  await f.host.controlTail;
  assert.equal(f.host.state().sending.camera.state, 'failed');
  assert.match(f.host.state().lastError, /generated capture timed out/);
  assert.deepEqual(f.sent.map(([cmd]) => cmd), [31, 49]);
  assert.equal(f.closed.at(-1), 'camera');
  f.sent.length = 0; f.opened[0].options.onError(new Error('duplicate'));
  await f.host.controlTail; assert.equal(f.sent.length, 0);
  await f.host.clear();
});

test('a generator failure during opening does not publish or continue camera startup', async () => {
  const f = await fixture(); await f.host.sources({ callId: 'a' }); f.sent.length = 0;
  f.outputs.open = async (kind, callId, options) => { options.onError(new Error('first generated frame failed')); return { nativeDeviceId: 'virtual-id' }; };
  await assert.rejects(f.host.startSend({ callId: 'a', kind: 'camera', sourceId: 'test-pattern' }), /first generated frame failed/);
  assert.deepEqual(f.sent.map(([cmd]) => cmd), [49, 31, 49]);
  assert.equal(f.host.state().sending.camera.state, 'failed');
  await f.host.clear();
});

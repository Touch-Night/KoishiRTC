// SPDX-License-Identifier: GPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMacAudioRouter, decodeDeviceUpdate } = require('./audio-route.cjs');
const env = { KOISHI_RTC_QQ_AUDIO_INPUT_NAME: 'BlackHole 2ch', KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME: 'BlackHole 16ch' };
const update = (input = 22, output = 16) => ({ cmd: 20061,
  value: [[16, 22], ['BlackHole 16ch', 'BlackHole 2ch'], ['rx', 'tx'],
    [16, 22], ['BlackHole 16ch', 'BlackHole 2ch'], ['rx', 'tx'], output, input, 1, 2] });

test('selection receipt alone never unlocks call commands; exact observed IDs do', async () => {
  const posted = [];
  const router = createMacAudioRouter({ env, send: async (cmd, params) => { posted.push([cmd, params]); } });
  assert.throws(() => router.assertCommandAllowed(4), /not confirmed/);
  router.assertCommandAllowed(1); // login must initialize the device service
  await router.onMessage(update(0, 0));
  assert.deepEqual(posted, [[102, [22, 16]], [103, []]]);
  assert.equal(router.status().ready, false);
  await router.onMessage({ cmd: 102, value: [1, ''] });
  assert.equal(router.status().ready, false);
  await router.onMessage(update());
  assert.equal(router.status().ready, true);
  assert.doesNotThrow(() => router.assertCommandAllowed(5));
});

test('native device change after readiness disables routes and stops the host', async () => {
  const failures = [];
  const router = createMacAudioRouter({ env, send: async () => {}, onFatal: error => failures.push(error.message) });
  await router.onMessage(update());
  await router.onMessage(update(0, 16));
  assert.equal(router.status().ready, false);
  assert.match(failures[0], /route changed/);
  assert.throws(() => router.assertCommandAllowed(5));
});

test('ambiguous virtual devices and mixed callback layouts fail closed', async () => {
  const router = createMacAudioRouter({ env, send: async () => {} });
  const message = update(); message.value[4] = ['BlackHole 2ch', 'BlackHole 2ch'];
  await router.onMessage(message);
  assert.equal(router.status().ready, false);
  assert.match(router.status().error, /unique/);
  assert.throws(() => decodeDeviceUpdate([[1], [], [], [], [], [], 0, 0, 0, 0]), /names/);
});

test('only two distinct explicit BlackHole routes are accepted', () => {
  const router = createMacAudioRouter({ env: {}, send: async () => assert.fail('must not post') });
  router.start();
  assert.match(router.status().error, /distinct explicit/);
  assert.throws(() => router.assertCommandAllowed(4));
});

test('loss of fresh native selection evidence after readiness stops the host', async () => {
  let now = 1, tick, fatal = false;
  const router = createMacAudioRouter({ env, now: () => now, send: async () => {}, onFatal: () => { fatal = true; },
    timers: { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => {} } });
  await router.onMessage(update()); router.start();
  await Promise.resolve(); now = 11002; tick();
  assert.equal(fatal, true); assert.equal(router.status().ready, false);
});

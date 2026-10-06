// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { AudioRouteGuard, decodeDevices } = createRequire(import.meta.url)('./route-guard.cjs');
const selection = { input: { id: 12, name: 'RTC TX recording' }, output: { id: 34, name: 'RTC RX playback' } };
function event(input = 12, output = 34) { return [[0, 34], ['Default', 'RTC RX playback'], ['', '{rx-guid}'], [0, 12], ['Default', 'RTC TX recording'], ['', '{tx-guid}'], output, input, 0, 0]; }
function harness({ selected = true, noReply = false, hang = false } = {}) {
  const posted = [], fatal = [];
  let guard;
  guard = new AudioRouteGuard({ timeoutMs: 25, post: async (command, id, params) => {
    posted.push({ command, id, params });
    if (hang) return new Promise(() => {});
    if (noReply) return;
    if (command === 103) guard.handle({ cmd: 20061, id: 0, value: event(selected ? 12 : 0, selected ? 34 : 0) });
    if (command === 102) guard.handle({ cmd: 102, id, value: [1, ''] });
  }, fatal: message => fatal.push(message) });
  return { guard, posted, fatal };
}
test('native 20061 preserves directions, excludes default, and validates string-array ABI', () => {
  const devices = decodeDevices(event()); assert.equal(devices.length, 2); assert.equal(devices[0].direction, 'output');
  assert.equal(devices[1].id, 12); assert.equal(devices[1].selected, true);
  const invalid = event(); invalid[2] = 2; assert.throws(() => decodeDevices(invalid), /Invalid/);
  const duplicate = event(); duplicate[0] = [34, 34]; assert.throws(() => decodeDevices(duplicate), /duplicated/);
});
test('route confirms fresh native selection after submission; no ack-as-success', async () => {
  const { guard, posted } = harness();
  assert.equal((await guard.configure(selection)).ready, true);
  assert.deepEqual(posted.map(p => p.command), [103, 102, 103]);
  assert.deepEqual(posted[1].params, [12, 34]);
  await guard.ensure(); assert.equal(posted.at(-1).command, 103); guard.close();
});
test('successful-looking selection ack with unchanged default route does not enable calls', async () => {
  const { guard } = harness({ selected: false });
  await assert.rejects(guard.configure(selection), /did not confirm/); assert.equal(guard.status().ready, false);
  await assert.rejects(guard.ensure(), /Configure/); guard.close();
});
test('default devices, equal buses and mismatched identities are refused', async () => {
  const { guard } = harness();
  await assert.rejects(guard.configure({ ...selection, input: { id: 0, name: 'Default' } }), /default/);
  await assert.rejects(guard.configure({ ...selection, input: { id: 12, name: selection.output.name } }), /separate/);
  await assert.rejects(guard.configure({ ...selection, input: { id: 12, name: 'Other input' } }), /exactly match/);
  guard.close();
});
test('device disappearance during a call fails closed once and never selects fallback', async () => {
  const { guard, posted, fatal } = harness(); await guard.configure(selection); guard.setCallActive(true);
  await assert.rejects(guard.configure(selection), /idle/);
  guard.handle({ cmd: 20061, value: event(0, 34) }); guard.handle({ cmd: 20061, value: event(0, 34) });
  assert.equal(guard.status().ready, false); assert.equal(fatal.length, 1);
  assert.equal(posted.filter(p => p.command === 102).length, 1); guard.close();
});
test('missing callbacks and stalled post promises both time out without fabricated devices', async () => {
  for (const flags of [{ noReply: true }, { hang: true }]) {
    const { guard } = harness(flags); await assert.rejects(guard.devices(), /timed out/); assert.equal(guard.status().ready, false); guard.close();
  }
});
test('closing rejects outstanding enumeration and consumes only its own private IDs', async () => {
  const { guard } = harness({ noReply: true }); const pending = guard.devices(); guard.close();
  await assert.rejects(pending, /closed/); assert.equal(guard.handle({ cmd: 5, id: 42, value: [0, ''] }), false);
  assert.equal(guard.handle({ cmd: 102, id: -22, value: [1, ''] }), true);
});

// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nativeProcessIds, createNativeHealth } = require('../av-host/native-health.cjs');

test('Linux health checks only this Host direct PPAPI children, without matching a broker or another QQ', () => {
  const files = new Map([
    ['/proc/100/task/100/children', '102 103'],
    ['/proc/100/task/109/children', '101'],
    ['/proc/101/cmdline', 'qq\0--type=ppapi\0'],
    ['/proc/102/cmdline', 'qq\0--type=ppapi-broker\0'],
    ['/proc/103/cmdline', 'qq\0--type=renderer\0'],
  ]);
  const fs = { readdirSync(path) { assert.equal(path, '/proc/100/task'); return ['100', '109']; },
    readFileSync(path) { assert.ok(files.has(path)); return files.get(path); } };
  assert.deepEqual(nativeProcessIds({ app: {}, fs, platform: 'linux', pid: 100 }), [101]);
});

test('Electron metrics select only native plugin processes on Windows and macOS', () => {
  const app = { getAppMetrics: () => [{ pid: 10, type: 'Pepper Plugin' }, { pid: 11, type: 'Pepper Plugin Broker' }, { pid: 12, type: 'Utility' }] };
  for (const platform of ['win32', 'darwin']) {
    assert.deepEqual(nativeProcessIds({ app, fs: { readFileSync() { throw new Error('not available'); } }, platform, pid: 1 }), [10]);
  }
});

test('unreadable Linux procfs cannot fall back to metrics that omit PPAPI', () => {
  assert.equal(nativeProcessIds({ platform: 'linux', pid: 100,
    fs: { readdirSync() { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); } },
    app: { getAppMetrics: () => [] } }), null);
});

test('missing crash callback is recovered only after an observed PPAPI disappears twice', () => {
  let ids = [], failures = [];
  const health = createNativeHealth({ read: () => ids, onGone: (...args) => failures.push(args) });
  health.check(); health.check(); assert.equal(failures.length, 0, 'startup is not a crash');
  ids = [42]; health.check();
  ids = []; health.check(); assert.equal(failures.length, 0);
  ids = null; health.check();
  ids = []; health.check(); assert.equal(failures.length, 0, 'unreadable process list breaks confirmation');
  health.check(); health.check();
  assert.deepEqual(failures, [['ppapi-process-missing', { reason: 'native-process-exited' }]]);
});

test('unobserved replacement PPAPI cannot silently inherit the old room and login state', () => {
  let ids = [42], failures = [];
  const health = createNativeHealth({ read: () => ids, onGone: (...args) => failures.push(args) });
  health.check(); ids = [43]; health.check(); health.check();
  assert.deepEqual(failures, [['ppapi-process-missing', { reason: 'native-process-replaced' }]]);
});

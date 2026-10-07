// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const isNativePlugin = type => /pepper|ppapi|plugin/i.test(type ?? '') && !/broker/i.test(type ?? '');

// Some QQ Electron builds silently lose PPAPI without emitting plugin-crashed
// or child-process-gone. Inspect only this Host's children, never another QQ.
function nativeProcessIds({ app, fs, platform, pid }) {
  if (platform === 'linux') {
    try {
      // Chromium spawns PPAPI from a worker thread. Linux exposes children per
      // task, so inspecting only the main thread silently misses that process.
      const children = new Set();
      for (const task of fs.readdirSync(`/proc/${pid}/task`)) {
        if (!/^\d+$/.test(task)) continue;
        try {
          for (const child of fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) children.add(child);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return null;
        }
      }
      const ids = [];
      for (const id of children) {
        if (!/^\d+$/.test(id)) return null;
        try {
          const args = fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').split('\0');
          if (args.includes('--type=ppapi')) ids.push(Number(id));
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') return null;
        }
      }
      return ids;
    } catch { return null; }
  }
  try {
    if (typeof app.getAppMetrics !== 'function') return null;
    return app.getAppMetrics().filter(item => isNativePlugin(item.type))
      .map(item => item.pid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
  } catch { return null; }
}

function createNativeHealth({ read, onGone }) {
  let observed = null, missing = 0, failed = false;
  return {
    check() {
      if (failed) return;
      const current = read();
      // An unsupported/failed inspection is not evidence of process death.
      if (!Array.isArray(current)) { missing = 0; return; }
      if (!observed) { if (current.length) observed = new Set(current); return; }
      if ([...observed].every(pid => current.includes(pid))) { missing = 0; return; }
      if (++missing < 2) return;
      failed = true;
      onGone('ppapi-process-missing', { reason: current.length ? 'native-process-replaced' : 'native-process-exited' });
    },
  };
}

module.exports = { nativeProcessIds, createNativeHealth, isNativePlugin };

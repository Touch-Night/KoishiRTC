// SPDX-License-Identifier: GPL-3.0-only
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const error = (code, message) => Object.assign(new Error(message), { code });
export class AccessibilityDriver {
  constructor(config, dependencies = {}) { this.config = config; this.spawn = dependencies.spawn ?? spawn; this.pending = new Map(); this.buffer = ''; this.child = null; }
  start() {
    if (this.child) return;
    const child = this.spawn(this.config.python ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-u', fileURLToPath(new URL('./accessibility_worker.py', import.meta.url)), '--application', JSON.stringify(this.config.application)], { stdio: ['pipe','pipe','pipe'], shell: false, windowsHide: true });
    this.child = child; this.buffer = '';
    child.stdout.on('data', data => {
      if (this.child !== child) return;
      this.buffer += data.toString('utf8');
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.fail(error('DESKTOP_PROTOCOL', 'Accessibility snapshot exceeded the size limit'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0,end); this.buffer = this.buffer.slice(end+1);
        try {
          const message = JSON.parse(line), pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id); pending.cleanup();
          if (message.ok === true) pending.resolve(message.result);
          else pending.reject(error('DESKTOP_ACTION', message.error?.message ?? 'Accessibility request failed'));
        } catch { this.fail(error('DESKTOP_PROTOCOL', 'Accessibility worker returned invalid JSON')); return; }
      }
    });
    child.stderr.on('data', () => {}); // Errors are returned as bounded protocol messages, never echo chat contents.
    child.stdin.on('error', () => this.fail(error('DESKTOP_OFFLINE', 'Accessibility worker input closed')));
    child.on('error', () => this.fail(error('DESKTOP_OFFLINE', 'Unable to start the configured accessibility interpreter')));
    child.on('exit', () => { if (this.child === child) this.fail(error('DESKTOP_OFFLINE', 'Accessibility worker exited')); });
  }
  request(operation, args = {}, signal) {
    signal?.throwIfAborted(); this.start();
    if (this.pending.size >= 4) return Promise.reject(error('BACKPRESSURE', 'Accessibility worker is busy'));
    const id = randomUUID(), child = this.child;
    return new Promise((resolve, reject) => {
      const abort = () => { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.cleanup(); reject(error('RESULT_UNKNOWN', 'Accessibility operation was interrupted; inspect application state before retrying')); } };
      const timeout = setTimeout(() => this.fail(error('DESKTOP_TIMEOUT', 'Accessibility operation timed out; state must be re-inspected')), 12000);
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ ...args, id, operation }) + '\n', failure => { if (failure) this.fail(error('DESKTOP_OFFLINE', 'Accessibility request could not be submitted')); });
    });
  }
  snapshot(signal) { return this.request('snapshot', {}, signal); }
  act(snapshot, node, operation, value, signal, guards) { return this.request(operation, { epoch: snapshot.epoch, nodeId: node.id, ...(value === undefined ? {} : { value }), ...(guards ? { guards } : {}) }, signal); }
  fail(reason) { for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(reason); } this.pending.clear(); const child = this.child; this.child = null; if (child && !child.killed) child.kill(); }
  async stop() { this.fail(error('DESKTOP_OFFLINE', 'Accessibility driver stopped')); }
}

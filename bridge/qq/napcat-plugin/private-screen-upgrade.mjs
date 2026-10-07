// SPDX-License-Identifier: GPL-3.0-only
// The official QQ DAV -> private MAV handover. It retains the logical call,
// but the native transport is interrupted; this is not an atomic renegotiation.
import { buildPrivateScreenUpgradeParams } from './native-profile.mjs';
import { createHash } from 'node:crypto';

const failure = (code, message) => Object.assign(new Error(message), { code });
export class PrivateScreenUpgrade {
  constructor({ requestId, selfUid, peerUid, peerUin, valid, invoke, prepare, beginRoom,
    restore, changed, failed, now = () => new Date().toISOString(), delayMs = 2000,
    acknowledgementMs = 2000, connectionMs = 15000, timeoutMs = 40000 }) {
    Object.assign(this, { requestId, selfUid, peerUid, peerUin, valid, invoke, prepare, beginRoom,
      restore, changed, failed, now, delayMs, acknowledgementMs, connectionMs, timeoutMs });
    const key = createHash('sha256').update(requestId).digest('hex');
    this.closeId = `screen-close:${key}`; this.startId = `screen-start:${key}`;
    this.progress = { kind: 'screen', requestId, status: 'preparing', startedAt: now(), interruption: true, audioReady: true };
    this.active = true; this.timers = new Set(); this.entered = false; this.peerJoined = false;
    this.startAcknowledged = false; this.crossedCloseBoundary = false;
    this.finished = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // The RPC attaches after preflight; native callbacks may already reject it.
    this.finished.catch(() => {});
    // Validate the trusted same-peer identity before touching the native call.
    this.parameters = buildPrivateScreenUpgradeParams({ selfUid, peerUid, peerUin });
  }
  current() { return this.active && this.valid(); }
  update(status) {
    this.progress = { ...this.progress, status, audioReady: ['restoring', 'completed'].includes(status) && this.entered && this.peerJoined,
      ...(status === 'completed' ? { finishedAt: this.now() } : {}) }; this.changed({ ...this.progress });
  }
  timer(callback, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); if (this.current()) callback(); }, delay);
    timer.unref?.(); this.timers.add(timer); return timer;
  }
  clearTimer(timer) { clearTimeout(timer); this.timers.delete(timer); }
  cancel(reason = 'Call changed during screen-share upgrade') {
    if (!this.active) return;
    this.active = false; for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.progress = { ...this.progress, status: 'cancelled', error: reason,
      audioReady: !this.crossedCloseBoundary || this.entered && this.peerJoined, finishedAt: this.now() };
    this.reject(failure('SCREEN_UPGRADE_CANCELLED', reason));
  }
  fail(error) {
    if (!this.current()) return;
    this.active = false; for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
    this.progress = { ...this.progress, status: 'failed', error: error.message, audioReady: !this.crossedCloseBoundary || this.entered && this.peerJoined,
      errorCode: error.code ?? 'SCREEN_UPGRADE_FAILED', finishedAt: this.now() };
    this.reject(error);
    this.failed({ ...this.progress }, this.crossedCloseBoundary);
  }
  async start() {
    try {
      this.timer(() => this.fail(failure('SCREEN_UPGRADE_TIMEOUT', 'Screen-share handover did not finish within its time budget')), this.timeoutMs);
      await this.prepare();
      if (!this.current()) throw failure('STALE_CALL', 'Call changed before screen-share upgrade');
      this.update('closing');
      // Submission may reach QQ even if its HTTP receipt is lost. Never retry.
      this.crossedCloseBoundary = true;
      this.closeTimer = this.timer(() => this.fail(failure('SCREEN_UPGRADE_CLOSE_TIMEOUT',
        'QQ did not acknowledge the screen-share handover; native call state is unknown')), this.acknowledgementMs);
      const result = await this.invoke(10, [1, this.peerUid, 8], this.closeId);
      if (!result?.posted || !Number.isInteger(result.id)) throw failure('SCREEN_UPGRADE_CLOSE_UNKNOWN', 'Screen-share handover submission is unknown');
    } catch (error) { this.fail(error); throw error; }
  }
  async startRoom() {
    if (!this.current()) return;
    try {
      this.update('negotiating'); this.beginRoom();
      this.connectionTimer = this.timer(() => this.fail(failure('SCREEN_UPGRADE_TIMEOUT',
        'The peer did not join the screen-share handover; the original voice transport cannot be restored automatically')), this.connectionMs);
      this.startTimer = this.timer(() => this.fail(failure('SCREEN_UPGRADE_START_TIMEOUT',
        'QQ did not acknowledge the screen-share handover invitation')), this.acknowledgementMs);
      const result = await this.invoke(4, this.parameters, this.startId);
      if (!result?.posted || !Number.isInteger(result.id)) throw failure('SCREEN_UPGRADE_START_UNKNOWN', 'Screen-share invitation submission is unknown');
    } catch (error) { this.fail(error); }
  }
  handle(command, value, requestId, observation) {
    if (!this.current()) return false;
    if (command === 10 && requestId === this.closeId) {
      if (this.progress.status !== 'closing') return true;
      this.clearTimer(this.closeTimer);
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== 0 || typeof value[1] !== 'string') {
        this.fail(failure('SCREEN_UPGRADE_CLOSE_FAILED', 'QQ refused the native screen-share handover')); return true;
      }
      this.update('negotiating');
      this.timer(() => { void this.startRoom(); }, this.delayMs);
      return true;
    }
    if (command === 4 && requestId === this.startId) {
      if (this.startAcknowledged) return true;
      this.clearTimer(this.startTimer);
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== 0 || typeof value[1] !== 'string') {
        this.fail(failure('SCREEN_UPGRADE_START_FAILED', 'QQ refused the screen-share handover invitation')); return true;
      }
      this.startAcknowledged = true; this.update('connecting'); return true;
    }
    if (command === 20004) {
      // Old uncorrelated connection callbacks cannot acknowledge the new room.
      if (!this.startAcknowledged) return true;
      if (!Array.isArray(value) || value[0] !== 0) {
        this.fail(failure('SCREEN_UPGRADE_CONNECT_FAILED', 'QQ could not connect the screen-share handover')); return true;
      }
      this.entered = true; this.finishIfConnected(); return true;
    }
    if (observation?.type === 'participant.join' && this.startAcknowledged && observation.participant.uid === this.peerUid) {
      this.peerJoined = true; this.finishIfConnected();
      return false;
    }
    if (observation?.type === 'peer.reject' || observation?.type === 'call.connectTimeout') {
      this.fail(failure('SCREEN_UPGRADE_REJECTED', 'The peer did not accept the screen-share handover')); return true;
    }
    return false;
  }
  finishIfConnected() {
    if (!this.current() || !this.entered || !this.peerJoined || this.progress.status === 'restoring') return;
    this.clearTimer(this.connectionTimer); this.update('restoring');
    // Do not wait for native media ACKs inside the native callback HTTP handler:
    // the Host forwards those ACKs through the same ordered callback transport.
    void Promise.resolve().then(async () => {
      if (!this.current()) return;
      await this.restore();
      if (!this.current()) return;
      this.update('completed'); this.active = false;
      for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
      this.resolve();
    }).catch(error => this.fail(error));
  }
}

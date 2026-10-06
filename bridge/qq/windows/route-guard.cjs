// SPDX-License-Identifier: GPL-3.0-only
'use strict';

/** Windows native callback RVA 0x2f2510: event 20061 carries output
 * ids/names/extra strings, input ids/names/extra strings, then four ids.
 * The GUI ignores the extra strings; they are NOT device counts. */
function decodeDevices(value) {
  if (!Array.isArray(value) || value.length !== 10) throw new Error('Unknown native audio-device event shape');
  const devices = [];
  for (const [direction, offset, selectedOffset] of [['output', 0, 6], ['input', 3, 7]]) {
    const ids = value[offset], names = value[offset + 1], extra = value[offset + 2];
    if (!Array.isArray(ids) || !Array.isArray(names) || ids.length !== names.length || ids.length > 256 ||
        !Array.isArray(extra) || extra.length > 256 || !extra.every(x => typeof x === 'string' && x.length <= 2048) ||
        ![6, 7, 8, 9].every(i => Number.isInteger(value[i]))) throw new Error('Invalid native audio-device list');
    const seen = new Set();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], name = names[i];
      if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff || typeof name !== 'string' || !name || name.length > 1024 || seen.has(id)) throw new Error('Invalid or duplicated native audio device');
      seen.add(id);
      // Zero is the GUI's automatic default selector and is never selectable here.
      if (id !== 0) devices.push({ id, name, direction, selected: value[selectedOffset] === id });
    }
  }
  return devices;
}

class AudioRouteGuard {
  constructor({ post, fatal, timeoutMs = 5000 }) {
    this.post = post; this.fatal = fatal; this.timeoutMs = timeoutMs;
    this.ready = false; this.callActive = false; this.selected = null; this.latest = []; this.error = null;
    this.waiters = new Set(); this.pending = new Map(); this.nextId = -1; this.busy = false; this.closed = false;
  }
  status() { return { ready: this.ready, selection: this.selected, error: this.error, evidence: 'native-device-list', runtimeTested: false }; }
  // The shared Host owns the periodic recheck. Keep a single monitor there.
  setCallActive(active) { this.callActive = active; }
  handle(message) {
    if (message?.cmd === 20061) {
      try {
        this.latest = decodeDevices(message.value);
        if (this.selected && !this.busy && !this.matches(this.latest, true)) this.invalidate('Selected virtual audio devices disappeared, changed identity, or are no longer selected');
        for (const waiter of [...this.waiters]) waiter.resolve(this.latest);
      } catch (error) { this.invalidate(error.message); for (const waiter of [...this.waiters]) waiter.reject(error); }
      return true;
    }
    if (Number.isInteger(message?.id) && message.id < 0) {
      const pending = this.pending.get(message.id);
      if (pending && pending.command === message.cmd) pending.resolve(message.value);
      return true;
    }
    return false;
  }
  invalidate(reason) { this.ready = false; this.error = reason; if (this.callActive) { this.setCallActive(false); this.fatal(reason); } }
  matches(devices, requireSelected) {
    return ['input', 'output'].every(direction => devices.some(d => d.direction === direction && d.id === this.selected?.[direction].id && d.name === this.selected[direction].name && (!requireSelected || d.selected)));
  }
  async query() {
    if (this.closed) throw new Error('AV Host is closed');
    let waiter;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.reject(new Error('Native device enumeration timed out')), this.timeoutMs);
      waiter = { resolve: value => { clearTimeout(timer); this.waiters.delete(waiter); resolve(value); }, reject: error => { clearTimeout(timer); this.waiters.delete(waiter); reject(error); } };
      this.waiters.add(waiter);
    });
    Promise.resolve().then(() => { if (this.closed) throw new Error('AV Host closed'); return this.post(103, this.nextId--, []); }).catch(error => waiter.reject(error));
    return result;
  }
  async devices() { return { devices: await this.query(), ...this.status() }; }
  async command(command, params) {
    const id = this.nextId--;
    let pending;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => pending.reject(new Error('Native route command timed out; delivery is unknown')), this.timeoutMs);
      pending = { command, resolve: value => { clearTimeout(timer); this.pending.delete(id); resolve(value); }, reject: error => { clearTimeout(timer); this.pending.delete(id); reject(error); } };
      this.pending.set(id, pending);
    });
    Promise.resolve().then(() => { if (this.closed) throw new Error('AV Host closed'); return this.post(command, id, params); }).catch(error => pending.reject(error));
    return result;
  }
  async configure(selection) {
    if (this.busy || this.callActive) throw new Error('Audio routing can only be changed while idle');
    for (const direction of ['input', 'output']) {
      const d = selection?.[direction];
      if (!Number.isInteger(d?.id) || d.id <= 0 || d.id > 0x7fffffff || typeof d.name !== 'string' || !d.name.trim() || /\b(default|primary sound|mapper)\b/i.test(d.name)) throw new Error('Choose explicit native virtual input and output devices; default devices are refused');
    }
    if (selection.input.name === selection.output.name) throw new Error('Use separate receive and transmit virtual audio buses');
    this.busy = true; this.ready = false;
    try {
      this.selected = JSON.parse(JSON.stringify({ input: selection.input, output: selection.output }));
      if (!this.matches(await this.query(), false)) throw new Error('Configured device IDs and names do not exactly match native enumeration');
      const ack = await this.command(102, [selection.input.id, selection.output.id]);
      // Windows SelectAudioDevice returns [1, ""] unconditionally after calling
      // native selection. It is submission evidence, not selection confirmation.
      if (!Array.isArray(ack) || ack.length !== 2 || ack[0] !== 1 || typeof ack[1] !== 'string') throw new Error('Unknown SelectAudioDevice acknowledgement');
      if (!this.matches(await this.query(), true)) throw new Error('Native device update did not confirm the selected routes');
      this.ready = true; this.error = null; return this.status();
    } catch (error) { this.invalidate(error.message); throw error; }
    finally { this.busy = false; }
  }
  async ensure() {
    if (!this.ready || !this.selected || this.busy) throw new Error('Configure and confirm both virtual audio endpoints before accepting or dialing');
    try {
      if (!this.matches(await this.query(), true)) throw new Error('Native audio routing changed');
    } catch (error) { this.invalidate(error.message); throw error; }
  }
  close() {
    this.closed = true; this.ready = false; this.setCallActive(false);
    for (const waiter of [...this.waiters]) waiter.reject(new Error('AV Host closed'));
    for (const pending of [...this.pending.values()]) pending.reject(new Error('AV Host closed'));
  }
}
module.exports = { AudioRouteGuard, decodeDevices };

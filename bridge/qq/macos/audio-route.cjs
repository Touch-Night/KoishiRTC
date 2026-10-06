// SPDX-License-Identifier: GPL-3.0-only
// Exact QQ Mac 7.0.2-53644 ABI, documented in native-evidence.json.
'use strict';

function decodeDeviceUpdate(value) {
  if (!Array.isArray(value) || value.length !== 10) throw new Error('Unexpected Mac audio-device callback layout');
  for (const i of [0, 3]) {
    if (!Array.isArray(value[i]) || value[i].length > 256 || !value[i].every(n => Number.isInteger(n) && n > 0)) {
      throw new Error('Invalid CoreAudio device identifiers');
    }
    for (const j of [i + 1, i + 2]) {
      if (!Array.isArray(value[j]) || value[j].length !== value[i].length || !value[j].every(n => typeof n === 'string' && n.length <= 4096)) {
        throw new Error('Invalid CoreAudio device names');
      }
    }
  }
  if (!value.slice(6).every(Number.isInteger)) throw new Error('Invalid CoreAudio device selection');
  return {
    outputs: value[0].map((id, i) => ({ id, name: value[1][i], details: value[2][i] })),
    inputs: value[3].map((id, i) => ({ id, name: value[4][i], details: value[5][i] })),
    selectedOutput: value[6], selectedInput: value[7], defaultOutput: value[8], defaultInput: value[9],
  };
}

function createMacAudioRouter({ send, onFatal = () => {}, env = process.env, intervalMs = 2000,
  now = () => Date.now(), timers = globalThis }) {
  // TX is QQ microphone, RX is QQ speaker. Both are mandatory explicit virtual routes.
  const inputName = env.KOISHI_RTC_QQ_AUDIO_INPUT_NAME;
  const outputName = env.KOISHI_RTC_QQ_AUDIO_OUTPUT_NAME;
  let timer = null, busy = false, selectionPending = false, lastUpdate = 0, everReady = false, disposed = false;
  let inputId = null, outputId = null;
  const state = { required: true, ready: false, inputName: inputName ?? null, outputName: outputName ?? null,
    evidence: 'QQ OnAudioDeviceUpdate selected CoreAudio IDs; no remote-audio proof', error: null };
  if (!inputName || !outputName || inputName === outputName ||
      !/^BlackHole (2|16)ch$/.test(inputName) || !/^BlackHole (2|16)ch$/.test(outputName)) {
    state.error = 'Set distinct explicit BlackHole 2ch/16ch names for QQ microphone and speaker';
  }
  function fail(error) {
    state.ready = false; state.error = error.message;
    if (everReady) { stop(); onFatal(error); }
  }
  async function refresh() {
    if (disposed || busy || state.error && !everReady) return;
    if (everReady && now() - lastUpdate > 10000) return fail(new Error('Native audio-device status became stale'));
    busy = true;
    try { await send(103, []); }
    catch (error) { fail(new Error('Mac audio enumeration failed: ' + error.message)); }
    finally { busy = false; }
  }
  function start() {
    if (disposed || timer || state.error) return;
    void refresh(); timer = timers.setInterval(() => void refresh(), intervalMs); timer.unref?.();
  }
  function stop() { disposed = true; if (timer) timers.clearInterval(timer); timer = null; state.ready = false; }
  async function onMessage(message) {
    if (disposed || state.error && !everReady || message?.cmd !== 20061) return false;
    try {
      const devices = decodeDeviceUpdate(message.value);
      const inputs = devices.inputs.filter(d => d.name === inputName);
      const outputs = devices.outputs.filter(d => d.name === outputName);
      if (inputs.length !== 1 || outputs.length !== 1 || inputs[0].id === outputs[0].id) {
        throw new Error('Both independent BlackHole devices must be present with unique native names');
      }
      const input = inputs[0].id, output = outputs[0].id;
      if (everReady && (input !== inputId || output !== outputId || devices.selectedInput !== input || devices.selectedOutput !== output)) {
        throw new Error('QQ audio route changed or a selected virtual device disappeared');
      }
      lastUpdate = now();
      if (devices.selectedInput === input && devices.selectedOutput === output) {
        state.ready = true; state.error = null; everReady = true; selectionPending = false;
        inputId = input; outputId = output;
      } else if (!selectionPending) {
        selectionPending = true;
        // Command 102 replies [1, ""] unconditionally; that reply is NOT success evidence.
        // Only a subsequent device callback showing the selected IDs makes ready true.
        await send(102, [input, output]);
        await send(103, []);
      }
    } catch (error) { fail(error); }
    return true;
  }
  return { start, stop, onMessage, status: () => ({ ...state }),
    assertCommandAllowed(command) {
      if ([4, 5, 18, 20].includes(command) && !state.ready) throw new Error(state.error || 'Explicit Mac audio routes are not confirmed');
    } };
}
module.exports = { createMacAudioRouter, decodeDeviceUpdate };

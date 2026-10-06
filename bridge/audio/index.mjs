import { PulseAudioBackend } from './pulse.mjs';
import { PortAudioBackend } from './portaudio.mjs';

/** Dependencies is reserved for deterministic tests; production calls only pass config. */
export function createAudioBackend(config = {}, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const backend = config.backend === 'auto' || !config.backend ? (platform === 'linux' ? 'pulse' : 'portaudio') : config.backend;
  if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error(`Audio backend is not supported on ${platform}.`);
  if (backend === 'pulse') {
    if (platform !== 'linux') throw new Error('PulseAudio backend requires Linux.');
    return new PulseAudioBackend(config, dependencies);
  }
  if (backend === 'portaudio') return new PortAudioBackend(config, dependencies);
  throw new Error(`Unknown audio backend: ${backend}`);
}

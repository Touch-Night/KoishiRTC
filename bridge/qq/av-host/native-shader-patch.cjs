// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const FROM = Buffer.from('precision mediump float;');
const TO = Buffer.from('precision highp   float;');
const WEIGHT = Buffer.from('vec4 weight4(float x)\n');

// Offsets and whole-file hashes belong to the exact official Linux ARM64 build.
// No QQ binary/shader source is distributed. Only its two precision qualifiers
// are replaced, with equal-length bytes, in a private generated copy.
const PATCH = Object.freeze({
  id: 'lanczos-highp-v1', profileId: 'qq-linux-3.2.34-53644-arm64',
  sourceSHA256: '07cf80b01fb42539ddc4d3a4e95853f26d51b8300ab0b7d4effe2986f1a6f34c',
  outputSHA256: 'a67fbdf9aaf21a77759be2e9464b5718a84f21eb6135490cc5f085ef3abd946b',
  shaders: [
    { offset: 0x1bc4d2, length: 1554, sha256: '206f57e3c739ead4b6605883c812f45be0f6e2969c1e817895022acdf9a3e7c5' },
    { offset: 0x1bcae4, length: 1580, sha256: 'd540a95e2219cbc32c6a52ca5c14213d0fa6f42bf55ad3f5e62ce851308a7beb' },
  ],
});

function count(bytes, needle) {
  let total = 0, offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) >= 0) { total++; offset += needle.length; }
  return total;
}

function applyShaderPrecisionPatch(original, audit = PATCH) {
  if (sha256(original) !== audit.sourceSHA256) throw new Error('QQ shader patch: original library SHA256 mismatch');
  if (FROM.length !== TO.length || audit.shaders.length !== 2 || count(original, WEIGHT) !== 2) throw new Error('QQ shader patch: unexpected shader pattern count');
  const output = Buffer.from(original);
  for (const shader of audit.shaders) {
    const bytes = original.subarray(shader.offset, shader.offset + shader.length);
    if (bytes.length !== shader.length || bytes.at(-1) !== 0 || sha256(bytes) !== shader.sha256 ||
        !bytes.subarray(0, FROM.length).equals(FROM) || count(bytes, WEIGHT) !== 1) {
      throw new Error('QQ shader patch: audited shader bytes do not match');
    }
    TO.copy(output, shader.offset);
  }
  if (output.length !== original.length || sha256(output) !== audit.outputSHA256) throw new Error('QQ shader patch: generated library SHA256 mismatch');
  return output;
}

function materializePatchedLibrary({ originalPath, cacheRoot, audit = PATCH }) {
  const original = fs.readFileSync(originalPath);
  const output = applyShaderPrecisionPatch(original, audit);
  // Each source installation gets its own dependency links. The generated
  // library retains $ORIGIN lookups without copying or editing QQ resources.
  const origin = fs.realpathSync(path.dirname(originalPath));
  const directory = path.join(cacheRoot, `${audit.id}-${sha256(origin).slice(0, 12)}`);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cacheRoot).isSymbolicLink()) throw new Error('QQ shader patch: cache root cannot be a symlink');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('QQ shader patch: invalid cache directory');
  const destination = path.join(directory, path.basename(originalPath));
  for (const entry of fs.readdirSync(origin)) {
    if (entry === path.basename(originalPath)) continue;
    const target = path.join(origin, entry), link = path.join(directory, entry);
    let info; try { info = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (!info.isSymbolicLink() || fs.readlinkSync(link) !== target) throw new Error('QQ shader patch: cached dependency has an unexpected target');
    } else fs.symlinkSync(target, link);
  }
  let cached; try { cached = fs.lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (cached && (!cached.isFile() || cached.isSymbolicLink())) throw new Error('QQ shader patch: invalid cached library');
  if (!cached || sha256(fs.readFileSync(destination)) !== audit.outputSHA256) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (sha256(fs.readFileSync(destination)) !== audit.outputSHA256) throw new Error('QQ shader patch: cached library verification failed');
  return { path: destination, patch: { id: audit.id, originalSHA256: audit.sourceSHA256, loadedSHA256: audit.outputSHA256 } };
}

function prepareNativeVideoLibrary({ originalPath, cacheRoot, profile }) {
  if (profile?.id !== PATCH.profileId) return { path: originalPath, patch: null };
  if (profile.platform !== 'linux' || profile.arch !== 'arm64' || profile.qqVersion !== '3.2.34-53644' || profile.librarySHA256 !== PATCH.sourceSHA256) {
    throw new Error('QQ shader patch: audited profile mismatch');
  }
  return materializePatchedLibrary({ originalPath, cacheRoot });
}

module.exports = { PATCH, applyShaderPrecisionPatch, materializePatchedLibrary, prepareNativeVideoLibrary };

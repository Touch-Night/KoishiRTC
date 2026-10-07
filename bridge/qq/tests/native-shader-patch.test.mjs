// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PATCH, applyShaderPrecisionPatch, materializePatchedLibrary, prepareNativeVideoLibrary } = require('../av-host/native-shader-patch.cjs');
const profiles = require('../av-host/profiles.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Synthetic data exercises the guards without distributing QQ shader source.
function fixture() {
  const a = Buffer.from('precision mediump float;\nvec4 weight4(float x)\n// synthetic NV12 fixture\0');
  const b = Buffer.from('precision mediump float;\nvec4 weight4(float x)\n// synthetic I420 fixture\0');
  const original = Buffer.concat([Buffer.alloc(17, 32), a, Buffer.alloc(13), b, Buffer.alloc(19, 7)]);
  const expected = Buffer.from(original);
  const shaders = [{ offset: 17, length: a.length, sha256: digest(a) }, { offset: 30 + a.length, length: b.length, sha256: digest(b) }];
  for (const shader of shaders) expected.write('precision highp   float;', shader.offset);
  const audit = { id: 'fixture', sourceSHA256: digest(original), outputSHA256: digest(expected), shaders };
  return { original, expected, audit };
}

test('shader precision patch changes only the two audited equal-length qualifiers', () => {
  const { original, expected, audit } = fixture();
  const output = applyShaderPrecisionPatch(original, audit);
  assert.deepEqual(output, expected); assert.equal(output.length, original.length);
  assert.equal(digest(original), audit.sourceSHA256, 'the input buffer is never edited');
  assert.equal([...original].filter((byte, i) => byte !== output[i]).length, 14);
  assert.throws(() => applyShaderPrecisionPatch(output, audit), /original library SHA256/);
});

test('shader patch rejects unknown bytes, shader offsets/counts and unverified output', () => {
  const { original, audit } = fixture();
  const changed = Buffer.from(original); changed[0] ^= 1;
  assert.throws(() => applyShaderPrecisionPatch(changed, audit), /original library SHA256/);
  assert.throws(() => applyShaderPrecisionPatch(original, { ...audit, shaders: [audit.shaders[0]] }), /pattern count/);
  assert.throws(() => applyShaderPrecisionPatch(original, { ...audit, shaders: [{ ...audit.shaders[0], offset: 18 }, audit.shaders[1]] }), /audited shader bytes/);
  assert.throws(() => applyShaderPrecisionPatch(original, { ...audit, outputSHA256: '0'.repeat(64) }), /generated library SHA256/);
  const extra = Buffer.concat([original, Buffer.from('vec4 weight4(float x)\n')]);
  assert.throws(() => applyShaderPrecisionPatch(extra, { ...audit, sourceSHA256: digest(extra) }), /pattern count/);
});

test('library copies are verified, idempotent, and preserve origin resources without editing originals', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-native-shader-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { original, expected, audit } = fixture();
  const directory = path.join(root, 'qq', 'avsdk'); fs.mkdirSync(directory, { recursive: true });
  const originalPath = path.join(directory, 'libAVSDKPlugin.so'); fs.writeFileSync(originalPath, original);
  fs.writeFileSync(path.join(directory, 'dependency.so'), 'fixture');
  fs.mkdirSync(path.join(directory, 'Shader')); fs.writeFileSync(path.join(directory, 'Shader', 'resource.txt'), 'fixture');
  const input = { originalPath, cacheRoot: path.join(root, 'runtime', 'native-video'), audit };
  const first = materializePatchedLibrary(input), before = fs.statSync(first.path);
  const second = materializePatchedLibrary(input);
  assert.equal(first.path, second.path); assert.equal(fs.statSync(second.path).ino, before.ino);
  assert.deepEqual(fs.readFileSync(originalPath), original);
  assert.deepEqual(fs.readFileSync(first.path), expected);
  assert.equal(fs.realpathSync(path.join(path.dirname(first.path), 'dependency.so')), path.join(directory, 'dependency.so'));
  assert.equal(fs.readFileSync(path.join(path.dirname(first.path), 'Shader', 'resource.txt'), 'utf8'), 'fixture');
  fs.writeFileSync(first.path, 'bad cache'); materializePatchedLibrary(input);
  assert.deepEqual(fs.readFileSync(first.path), expected, 'a corrupt cached copy is regenerated atomically');
  fs.unlinkSync(first.path); fs.symlinkSync(originalPath, first.path);
  assert.throws(() => materializePatchedLibrary(input), /invalid cached library/);
  assert.deepEqual(fs.readFileSync(originalPath), original, 'cache symlinks cannot overwrite QQ');
});

test('only the exact audited Linux ARM64 profile may prepare a patched SDK', () => {
  const target = profiles.find(profile => profile.id === PATCH.profileId);
  for (const profile of [null, ...profiles.filter(item => item !== target), { ...target, id: 'unknown-build' }]) {
    assert.deepEqual(prepareNativeVideoLibrary({ originalPath: '/not-read/unknown.so', cacheRoot: '/not-created', profile }), { path: '/not-read/unknown.so', patch: null });
  }
  for (const changed of [{ arch: 'x64' }, { platform: 'darwin' }, { qqVersion: 'other' }, { librarySHA256: '0'.repeat(64) }]) {
    assert.throws(() => prepareNativeVideoLibrary({ originalPath: '/not-read/unknown.so', cacheRoot: '/not-created', profile: { ...target, ...changed } }), /profile mismatch/);
  }
});

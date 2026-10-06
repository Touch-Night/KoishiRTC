// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../scripts/install.py', import.meta.url));
function elfHeader(architecture = os.arch()) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE({ arm64: 183, x64: 62 }[architecture], 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  return header;
}
async function fixture(t, withLibrary = false, architecture = os.arch()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'koishi-rtc-install-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const qq = path.join(dir, 'QQ with spaces'), napcat = path.join(dir, 'napcat'), target = path.join(dir, 'bridge');
  const app = path.join(qq, 'resources/app');
  await fs.mkdir(app, { recursive: true }); await fs.mkdir(path.join(napcat, 'config'), { recursive: true });
  await fs.writeFile(path.join(qq, 'qq'), elfHeader(architecture));
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ main: './loadNapCat.js', version: 'fixture' }));
  await fs.writeFile(path.join(app, 'loadNapCat.js'), '// Original fixture loader\n');
  await fs.writeFile(path.join(napcat, 'napcat.mjs'), '// fixture');
  await fs.writeFile(path.join(napcat, 'config/plugins.json'), JSON.stringify({ other: true, 'napcat-plugin-koishi-rtc-qq': false }));
  if (withLibrary) {
    await fs.mkdir(path.join(app, 'avsdk'));
    await fs.writeFile(path.join(app, 'avsdk/libAVSDKPlugin.so'), elfHeader(architecture));
  }
  // Stub platform.machine only inside this test process; the installer exposes
  // no switch that could bypass its real host architecture check.
  const run = (operation, extras = [], environment = process.env, machine) => spawnSync('python3', [
    ...(machine === undefined ? [] : ['-c', 'import platform,runpy,sys; machine=sys.argv.pop(1); entry=sys.argv.pop(1); platform.machine=lambda:machine; sys.argv[0]=entry; runpy.run_path(entry,run_name="__main__")', machine]),
    installer, operation, '--qq-dir', qq,
    '--napcat-dir', napcat, '--install-dir', target, ...extras], { encoding: 'utf8', env: environment });
  return { qq, napcat, target, app, run };
}
test('diagnostics-only install and uninstall preserve loader, unrelated config and original flag', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.qq, 'qq'), 'diagnostics fixture: no valid ELF required');
  const check = f.run('install', ['--diagnostics-only', '--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).plan.architectures, null);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const installed = f.run('install', ['--diagnostics-only']);
  assert.equal(installed.status, 0, installed.stderr);
  for (const relative of ['audio/common.mjs', 'video/virtual_camera_worker.py', 'video/requirements.txt', 'video/demo.mjs']) await fs.access(path.join(f.target, relative));
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(f.target, 'video/index.mjs')).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(await fs.readFile(path.join(f.app, 'loadNapCat.js'), 'utf8'), '// Original fixture loader\n');
  const token = path.join(f.target, 'runtime/control.token');
  assert.equal((await fs.stat(token)).mode & 0o777, 0o600);
  const configFile = path.join(f.napcat, 'config/plugins.json');
  assert.deepEqual(JSON.parse(await fs.readFile(configFile)), { other: true, 'napcat-plugin-koishi-rtc-qq': true });
  assert.equal(f.run('uninstall').status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(configFile)), { other: true, 'napcat-plugin-koishi-rtc-qq': false });
  assert.ok((await fs.readFile(token, 'utf8')).trim().length >= 32);
});
test('media preflight fails honestly without AVSDK and does not change files', async t => {
  const f = await fixture(t);
  const failed = f.run('install', ['--check']);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /AVSDK library is missing/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});
test('media preflight accepts matching arm64/x64 ELF headers and reports all architectures', async t => {
  for (const [architecture, machine] of [['arm64', 'aarch64'], ['x64', 'x86_64']]) {
    await t.test(architecture, async t => {
      const f = await fixture(t, true, architecture);
      const result = f.run('install', ['--check'], process.env, machine);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).plan.architectures,
        { host: architecture, qq: architecture, avsdk: architecture });
      await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
    });
  }
});
test('media preflight rejects mixed QQ/AVSDK or foreign host architectures before compiling or writing', async t => {
  for (const [qqArchitecture, avsdkArchitecture, machine] of [
    ['x64', 'arm64', 'x86_64'], ['arm64', 'x64', 'aarch64'],
    ['x64', 'x64', 'aarch64'], ['arm64', 'arm64', 'x86_64'],
  ]) {
    await t.test(`${qqArchitecture}/${avsdkArchitecture}/${machine}`, async t => {
      const f = await fixture(t, true, qqArchitecture);
      await fs.writeFile(path.join(f.app, 'avsdk/libAVSDKPlugin.so'), elfHeader(avsdkArchitecture));
      const result = f.run('install', [], { ...process.env, CC: '/nonexistent/qq-guard-compiler' }, machine);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /QQ\/AVSDK architecture mismatch/);
      await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(f.app, 'loadNapCat.js'), 'utf8'), '// Original fixture loader\n');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.napcat, 'config/plugins.json'))),
        { other: true, 'napcat-plugin-koishi-rtc-qq': false });
    });
  }
});
test('media preflight rejects malformed and unsupported ELF headers without running QQ', async t => {
  const malformed = [
    ['truncated', header => header.subarray(0, 20)],
    ['not ELF', () => Buffer.from('fixture only: never executed')],
    ['32 bit', header => { header[4] = 1; return header; }],
    ['big endian', header => { header[5] = 2; return header; }],
    ['invalid ident version', header => { header[6] = 0; return header; }],
    ['invalid version', header => { header.writeUInt32LE(0, 20); return header; }],
    ['invalid header size', header => { header.writeUInt16LE(20, 52); return header; }],
    ['unsupported machine', header => { header.writeUInt16LE(243, 18); return header; }],
  ];
  for (const binary of ['qq', 'resources/app/avsdk/libAVSDKPlugin.so']) {
    for (const [name, corrupt] of malformed) {
      await t.test(`${binary}: ${name}`, async t => {
        const f = await fixture(t, true, 'x64');
        await fs.writeFile(path.join(f.qq, binary), corrupt(elfHeader('x64')));
        const result = f.run('install', [], { ...process.env, CC: '/nonexistent/qq-guard-compiler' }, 'x86_64');
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /ELF64 little-endian header|Unsupported ELF architecture/);
        await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
      });
    }
  }
});
test('unsupported host architecture blocks media but does not restrict diagnostics', async t => {
  const f = await fixture(t, true, 'x64');
  const failed = f.run('install', ['--check'], process.env, 'riscv64');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Linux arm64\/x64 hosts only/);
  const diagnostics = f.run('install', ['--diagnostics-only', '--check'], process.env, 'riscv64');
  assert.equal(diagnostics.status, 0, diagnostics.stderr);
  assert.equal(JSON.parse(diagnostics.stdout).plan.architectures, null);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});
test('reversible media loader hook survives repeat install and refuses modified loader on removal', async t => {
  const f = await fixture(t, true);
  let result = f.run('install'); assert.equal(result.status, 0, result.stderr);
  result = f.run('install'); assert.equal(result.status, 0, result.stderr);
  const loader = path.join(f.app, 'loadNapCat.js');
  const hooked = await fs.readFile(loader, 'utf8'); assert.match(hooked, /KOISHI_RTC_QQ_LOADER_HOOK_V1/);
  await fs.writeFile(loader, hooked + '// external change\n');
  result = f.run('uninstall'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loader changed/);
  await fs.writeFile(loader, hooked);
  result = f.run('uninstall'); assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(loader, 'utf8'), '// Original fixture loader\n');
});


test('isolated distribution includes imported hashed chunks and never copies account state', async t => {
  const f = await fixture(t, true);
  const bundle = "const a = A.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();\nconst b = B.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();\nimport './conout-fixture.js';\n";
  await fs.writeFile(path.join(f.napcat, 'napcat.mjs'), bundle);
  await fs.writeFile(path.join(f.napcat, 'conout-fixture.js'), 'export default true;');
  await fs.writeFile(path.join(f.napcat, 'secret-account.json'), 'should not copy');
  await fs.mkdir(path.join(f.napcat, 'logs'));
  await fs.writeFile(path.join(f.napcat, 'logs/account.log'), 'should not copy');
  const target = path.join(path.dirname(f.target), 'isolated');
  const result = spawnSync('python3', [fileURLToPath(new URL('../scripts/prepare-linux-test.py', import.meta.url)),
    '--qq-source', f.qq, '--napcat-source', f.napcat, '--target', target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(target, 'napcat/conout-fixture.js'), 'utf8'), 'export default true;');
  await assert.rejects(fs.stat(path.join(target, 'napcat/secret-account.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(target, 'napcat/logs')), { code: 'ENOENT' });
  const prepared = await fs.readFile(path.join(target, 'napcat/napcat.mjs'), 'utf8');
  assert.ok(!prepared.includes('getNTUserDataInfoConfig()'));
  assert.ok(prepared.includes('bridge/runtime/qq-data'));
  assert.equal(await fs.readFile(path.join(f.napcat, 'napcat.mjs'), 'utf8'), bundle);
});

test('uninstall restores the exact explicit local bootstrap bundle and loader without weakening the official list', async t => {
  const f = await fixture(t, true);
  const bundle = 'const official = new Set(["napcat-plugin-builtin"]);\n// not in official plugin whitelist\nasync function scan() {\n    const n = this.getLoadedPlugins().length;\n}\n';
  await fs.writeFile(path.join(f.napcat, 'napcat.mjs'), bundle);
  assert.equal(f.run('install').status, 0);
  const loader = path.join(f.app, 'loadNapCat.koishi-rtc-qq.backup.cjs');
  const patch = spawnSync('python3', [fileURLToPath(new URL('../scripts/enable-local-plugin.py', import.meta.url)),
    '--napcat-dir', f.napcat, '--loader', loader], { encoding: 'utf8' });
  assert.equal(patch.status, 0, patch.stderr);
  assert.equal(f.run('uninstall', ['--check']).status, 0);
  assert.match(await fs.readFile(path.join(f.napcat, 'napcat.mjs'), 'utf8'), /KOISHI_RTC_EXPLICIT_LOCAL_PLUGIN_V1/);
  const removed = f.run('uninstall'); assert.equal(removed.status, 0, removed.stderr);
  assert.equal(await fs.readFile(path.join(f.napcat, 'napcat.mjs'), 'utf8'), bundle);
  assert.equal(await fs.readFile(path.join(f.app, 'loadNapCat.js'), 'utf8'), '// Original fixture loader\n');
  await fs.stat(path.join(f.napcat, 'koishi-rtc-local-bootstrap.restored.json'));
});


test('media installation builds its mandatory native guard locally and stops before writes without a compiler', async t => {
  const f = await fixture(t, true);
  const failed = f.run('install', [], { ...process.env, CC: '/nonexistent/qq-guard-compiler' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /native C compiler/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  const result = f.run('install'); assert.equal(result.status, 0, result.stderr);
  const binary = await fs.readFile(path.join(f.target, 'audio/qq-pulse-guard.so'));
  assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
  await fs.stat(path.join(f.target, 'audio/qq-pulse-guard.c'));
  await fs.stat(path.join(f.target, 'audio/build-qq-pulse-guard.mjs'));
  const manifest = JSON.parse(await fs.readFile(path.join(f.target, 'runtime/install-manifest.json')));
  assert.equal(manifest.audioShim, path.join(f.target, 'audio/qq-pulse-guard.so'));
  assert.equal(manifest.audioShimSHA256.length, 64);
});

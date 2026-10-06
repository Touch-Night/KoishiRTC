// SPDX-License-Identifier: GPL-3.0-only
// Downloads only. Never installs, extracts, or executes the official package.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const source = 'https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe';
const expectedSHA256 = '63255c70c7ff523e7eed7d52d9708ed7a77ea346ece6474c65dded406edb3155';
const expectedBytes = 330446512;
const destination = path.resolve(process.argv[2] ?? 'QQ_9.9.36_260924_x64_01.exe');
let ownedPartial = false;
try {
  if (fs.existsSync(destination) || fs.existsSync(destination + '.partial')) throw new Error('Choose a new destination: existing files are not replaced');
  if (!fs.existsSync(path.dirname(destination))) throw new Error('Create the destination directory first');
  const signed = await fetch('https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://im.qq.com/index/',
      'x-oidb': JSON.stringify({ uint32_command: '0x9b8e', uint32_service_type: 1 }) },
    body: JSON.stringify({ url: source }), signal: AbortSignal.timeout(30000),
  });
  if (!signed.ok) throw new Error(`Official URL signing returned HTTP ${signed.status}`);
  const result = await signed.json();
  if (result.retcode !== 0 || typeof result.data?.url !== 'string') throw new Error('Official URL signing refused this pinned package');
  const url = new URL(result.data.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.gtimg.cn')) throw new Error('Unexpected official download host');
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Official download returned HTTP ${response.status}`);
  const digest = createHash('sha256'); let bytes = 0;
  const fd = fs.openSync(destination + '.partial', 'wx', 0o600); ownedPartial = true;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length; if (bytes > expectedBytes) return done(new Error('Pinned package size exceeded'));
    digest.update(chunk); done(null, chunk);
  } }), fs.createWriteStream(destination + '.partial', { fd, autoClose: true }));
  const sha256 = digest.digest('hex');
  if (bytes !== expectedBytes || sha256 !== expectedSHA256) throw new Error('Pinned package size/SHA256 mismatch; downloaded data removed');
  // Exclusive copy works on NTFS/exFAT and does not replace concurrent user files.
  fs.copyFileSync(destination + '.partial', destination, fs.constants.COPYFILE_EXCL); fs.unlinkSync(destination + '.partial'); ownedPartial = false;
  console.log(JSON.stringify({ ok: true, destination, bytes, sha256, executed: false }, null, 2));
} catch (error) {
  if (ownedPartial) fs.rmSync(destination + '.partial', { force: true });
  // Never print the ephemeral signed URL or its query parameters.
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1;
}

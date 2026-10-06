import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { validateJpeg } = createRequire(import.meta.url)('../av-host/jpeg.cjs');
// Complete, independently encoded 2x3 RGB JPEG fixtures (Pillow/libjpeg).
// No image decoder, Electron, native QQ or Python is needed to run these tests.
const baseline = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDj6KKK9Q8k/9k=', 'base64');
const progressive = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAE/9oADAMBAAIQAxAAAAGOFE//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==', 'base64');

const rejects = (bytes, width = 2, height = 3) => assert.throws(() => validateJpeg(bytes, width, height), error => error.code === 'INVALID_VIDEO');
const sofAt = bytes => { const pos = bytes.indexOf(Buffer.from([255,192])); return pos < 0 ? bytes.indexOf(Buffer.from([255,194])) : pos; };
const changeDimensions = (bytes, width, height) => { const copy = Buffer.from(bytes), pos = sofAt(copy); copy.writeUInt16BE(height, pos + 5); copy.writeUInt16BE(width, pos + 7); return copy; };

test('complete baseline and multi-scan progressive JPEG pass with their actual SOF dimensions', () => {
  for (const bytes of [baseline, progressive]) {
    assert.deepEqual(validateJpeg(bytes, 2, 3), { width: 2, height: 3 });
    assert.deepEqual(validateJpeg(new Uint8Array(bytes), 2, 3), { width: 2, height: 3 });
  }
});

test('claimed dimensions cannot hide a larger decoded image or swap portrait geometry', () => {
  rejects(baseline, 3, 2); rejects(baseline, 1, 1);
  rejects(changeDimensions(baseline, 65535, 65535));
  rejects(changeDimensions(baseline, 4097, 1), 4097, 1);
  rejects(changeDimensions(baseline, 2048, 2048), 2048, 2048);
  // Structural preflight permits portrait dimensions at the area limit. The
  // native decoder must still validate actual compressed samples afterwards.
  assert.deepEqual(validateJpeg(changeDimensions(baseline, 1080, 1920), 1080, 1920), { width: 1080, height: 1920 });
  for (const dimension of [0, -1, NaN, Infinity, 2.5, '2']) rejects(baseline, dimension, 3);
});

test('every truncated prefix is rejected, including complete SOF with missing scan or EOI', () => {
  for (const bytes of [baseline, progressive]) for (let end = 0; end < bytes.length; end++) rejects(bytes.subarray(0, end));
  rejects(Buffer.from([255,216,255,217])); rejects(Buffer.concat([baseline, Buffer.from([0])]));
});

test('missing, duplicate and geometry-redefining SOF markers are rejected', () => {
  const at = sofAt(baseline), length = baseline.readUInt16BE(at + 2), segment = baseline.subarray(at, at + 2 + length);
  rejects(Buffer.concat([baseline.subarray(0, at), baseline.subarray(at + 2 + length)]));
  rejects(Buffer.concat([baseline.subarray(0, at), segment, baseline.subarray(at)]));
  for (const marker of [195, 197, 201, 220, 222, 223]) { const copy = Buffer.from(baseline); copy[at + 1] = marker; rejects(copy); }
  const zeroHeight = changeDimensions(baseline, 2, 0); rejects(zeroHeight);
});

test('segment lengths and coding table/component structures cannot overrun or masquerade as a complete JPEG', () => {
  const app = Buffer.from(baseline); app.writeUInt16BE(65535, 4); rejects(app);
  for (const length of [0,1,2,8,16,65535]) { const copy = Buffer.from(baseline); copy.writeUInt16BE(length, sofAt(copy) + 2); rejects(copy); }
  const precision = Buffer.from(baseline); precision[sofAt(precision) + 4] = 12; rejects(precision);
  const component = Buffer.from(baseline); component[sofAt(component) + 13] = component[sofAt(component) + 10]; rejects(component);
  const dht = Buffer.from(baseline), h = dht.indexOf(Buffer.from([255,196])); dht[h + 5] = 255; rejects(dht);
  const dqt = Buffer.from(baseline), q = dqt.indexOf(Buffer.from([255,219])); dqt[q + 4] = 0x20; rejects(dqt);
  const sos = Buffer.from(baseline), scan = sos.indexOf(Buffer.from([255,218])); sos[scan + 5] = 99; rejects(sos);
  rejects(Buffer.concat([baseline.subarray(0, scan + 2 + baseline.readUInt16BE(scan + 2)), Buffer.from([255,217])]));
});

test('APP payload marker-looking bytes are skipped and entropy stuffing is handled independently', () => {
  const opaqueApp = Buffer.from([255,225,0,8,255,192,255,217,255,0]);
  assert.deepEqual(validateJpeg(Buffer.concat([baseline.subarray(0,2), opaqueApp, baseline.subarray(2)]), 2, 3), { width: 2, height: 3 });
  const scan = baseline.indexOf(Buffer.from([255,218])), entropy = scan + 2 + baseline.readUInt16BE(scan + 2);
  const stuffed = Buffer.concat([baseline.subarray(0,entropy), Buffer.from([1,255,0,2,255,217])]);
  assert.deepEqual(validateJpeg(stuffed, 2, 3), { width: 2, height: 3 });
  rejects(Buffer.concat([baseline.subarray(0,entropy), Buffer.from([1,255,255,0,255,217])]));
  rejects(Buffer.concat([baseline.subarray(0,entropy), Buffer.from([1,255,208,255,217])]));
});

test('byte-size bound and supported input type are checked before marker parsing', () => {
  rejects(Buffer.alloc(262145)); rejects(baseline.toString('base64')); rejects(null); rejects(new DataView(baseline.buffer));
  const padded = Buffer.concat([baseline.subarray(0,2), ...Array.from({ length: 4 }, () => Buffer.concat([Buffer.from([255,225,255,255]), Buffer.alloc(65533)])), baseline.subarray(2)]);
  rejects(padded);
});


test('restart markers require a declared interval, ordered numbering and intervening entropy data', () => {
  const scan = baseline.indexOf(Buffer.from([255,218])), entropy = scan + 2 + baseline.readUInt16BE(scan + 2);
  const header = Buffer.concat([baseline.subarray(0,scan), Buffer.from([255,221,0,4,0,1]), baseline.subarray(scan,entropy)]);
  assert.deepEqual(validateJpeg(Buffer.concat([header, Buffer.from([1,255,208,2,255,209,3,255,217])]), 2, 3), { width: 2, height: 3 });
  rejects(Buffer.concat([header, Buffer.from([1,255,209,2,255,217])]));
  rejects(Buffer.concat([header, Buffer.from([1,255,208,255,209,2,255,217])]));
});

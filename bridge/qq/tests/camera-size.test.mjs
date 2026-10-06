import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { cameraRenderSize } = createRequire(import.meta.url)('../av-host/camera-size.cjs');
test('NV12 camera output has no mmap tail padding on supported Linux page sizes', () => {
  for (const page of [4096,8192,16384,32768,65536]) {
    const { width, height } = cameraRenderSize(page);
    assert.equal(width * height * 3 / 2 % page, 0);
    assert.ok(height >= 576 && height <= 1080);
    assert.equal(width, 1024);
  }
  assert.deepEqual(cameraRenderSize(4096), {width:1024,height:576});
  assert.deepEqual(cameraRenderSize(65536), {width:1024,height:640});
  assert.throws(()=>cameraRenderSize(5000), /page size/);
});

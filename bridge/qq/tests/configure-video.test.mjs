import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureVideo, validateVideoConfig } from '../scripts/configure-video.mjs';
const options={ backend:'obs', device:'OBS Virtual Camera', python:'/usr/bin/python3', qqDeviceId:'native-observed-camera-id' };
test('Windows and macOS virtual camera settings require exact device mapping',()=>{
  for(const platform of ['win32','darwin']) {
    assert.equal(validateVideoConfig(options,platform).virtualCamera.qqDeviceId,options.qqDeviceId);
    assert.throws(()=>validateVideoConfig({...options,qqDeviceId:undefined},platform),/actual QQ/);
    assert.throws(()=>validateVideoConfig({...options,backend:'v4l2loopback'},platform),/supported/);
    assert.throws(()=>validateVideoConfig({...options,device:'default'},platform),/exact/);
  }
});
test('configuration probes Python imports without devices, preserves existing files by default',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rtc-video-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'runtime'));fs.mkdirSync(path.join(dir,'video'));
  fs.writeFileSync(path.join(dir,'runtime/control.token'),'test-token-not-displayed');fs.writeFileSync(path.join(dir,'video/virtual_camera_worker.py'),'');
  const calls=[], deps={platform:'darwin',spawnSync:(exe,args)=>{calls.push({exe,args});return {status:0,stdout:JSON.stringify({available:true,platform:'darwin',opensDevices:false})};}};
  const input={...options,bridgeDir:dir};
  const check=configureVideo({...input,check:true},deps);assert.equal(check.checkedOnly,true);assert.equal(fs.existsSync(path.join(dir,'runtime/video.json')),false);
  const saved=configureVideo(input,deps);assert.equal(saved.opensDevices,false);assert.equal(calls[0].args.at(-1),'--diagnostics');
  assert.throws(()=>configureVideo(input,deps),/already exists/);
  configureVideo({...input,replace:true},deps);
  assert.equal(JSON.parse(fs.readFileSync(saved.file)).virtualCamera.qqDeviceId,options.qqDeviceId);
});

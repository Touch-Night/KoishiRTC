import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialize, validateSnapshot } from './setup.mjs';
import { execFileSync } from 'node:child_process';

test('setup creates private explicit config without starting a client or enabling controls',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rtc-desktop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const directory=path.join(root,'new');
  const result=await initialize({directory,platform:'wechat',os:process.platform,executable:path.resolve('app-fixture'),selfId:'self',input:'call-transmit',output:'call-receive'});
  assert.equal(result.controlsEnabled,false);assert.equal(result.startsProcesses,false);
  const config=JSON.parse(await fs.readFile(result.configFile));assert.equal(config.audio.inputDevice,'');assert.equal(config.audio.outputDevice,'');assert.equal(config.account.selfId,'self');assert.deepEqual(config.desktop.targets,[]);
  const profile=JSON.parse(await fs.readFile(result.profileFile));assert.equal(profile.evidenceMode,'preflight');assert.equal(profile.calibrated,false);
  assert.equal((await fs.readFile(result.tokenFile,'utf8')).trim().length,64);
  await assert.rejects(initialize({directory,platform:'wechat',executable:path.resolve('app-fixture'),selfId:'self',input:'tx',output:'rx'}),e=>e.code==='EEXIST');
});
test('read-only preflight report distinguishes missing hidden evidence from a verified probe',async()=>{
  const profile=JSON.parse(await fs.readFile(new URL('./profiles/wechat-linux.json',import.meta.url)));
  const report=validateSnapshot(profile,{truncated:false,processIdentity:'1:2',nodes:[]},{self:'self',target:'peer',input:'tx',output:'rx'});
  assert.equal(report.ready,false);assert.equal(report.enablesControls,false);assert.equal(report.evidenceMode,'preflight');assert.match(report.note,/never invokes/);
});
test('native worker evidence validation handles hierarchy, duplicates and absence',()=>{
  const script=String.raw`
import importlib.util
spec=importlib.util.spec_from_file_location('worker','bridge/desktop/accessibility_worker.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
nodes=[{'id':'window','name':'Call','role':'window','visible':True},{'id':'peer','name':'peer-A','role':'text','visible':True,'parentId':'window'}]
s={'nodes':nodes,'truncated':False}
g={'all':[{'name':'peer-A','ancestor':{'name':'Call'}}],'none':[{'name':'incoming'}]}
m.check_guards(s,g)
nodes[1]['name']='peer-B'
try:m.check_guards(s,g);raise AssertionError('wrong target allowed')
except ValueError:pass
nodes[1]['name']='peer-A';nodes.append({'id':'new','name':'incoming','visible':True})
try:m.check_guards(s,g);raise AssertionError('incoming interruption allowed')
except ValueError:pass
s['truncated']=True
try:m.check_guards(s,g);raise AssertionError('incomplete snapshot allowed')
except ValueError:pass
print('verified')
`;
  assert.equal(execFileSync(process.platform==='win32'?'python':'python3',['-c',script],{cwd:new URL('../../',import.meta.url),encoding:'utf8'}).trim(),'verified');
});

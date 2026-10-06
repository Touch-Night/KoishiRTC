import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DesktopControl } from './control.mjs';
import { validateProfile, exactNode, matchesAll } from './profile.mjs';
function fixture(options={}) {
  const selector=name=>({name}), profile={formatVersion:1,platform:'wechat',os:'linux',calibrated:true,identity:selector('{self}'),target:selector('{target}'),audioInput:selector('{input}'),audioOutput:selector('{output}'),states:{idle:[selector('idle')],ringing:[selector('ringing')],dialing:[selector('dialing')],connected:[selector('connected')]},actions:{dial:{kind:'direct',steps:[{kind:'invoke',selector:selector('dial'),commit:true}]},accept:{kind:'direct',steps:[{kind:'invoke',selector:selector('accept'),commit:true}]},reject:{kind:'direct',steps:[{kind:'invoke',selector:selector('reject'),commit:true}]},hangup:{kind:'direct',steps:[{kind:'invoke',selector:selector('hangup'),commit:true}]}}};
  const ui={phase:'idle',target:'peer',route:true,identity:'self',process:'100:1000',invocations:[],duplicates:false,truncated:false};let epoch=0;
  const driver={async snapshot(){const names=[ui.identity,ui.phase,ui.target,'dial','accept','reject','hangup',...(ui.route?['tx-virtual','rx-virtual']:[]),...(ui.duplicates?[ui.target]:[])];return {epoch:String(++epoch),processIdentity:ui.process,observedAt:Date.now(),truncated:ui.truncated,nodes:names.map((name,index)=>({id:String(index),parentId:null,name,role:'button',value:'',automationId:'',description:'',className:'',visible:true,enabled:true,protected:false,actions:['invoke']}))};},async act(snapshot,node,operation,value){assert.equal(snapshot.epoch,String(epoch));ui.invocations.push(node.name);ui.phase=node.name==='dial'?'dialing':node.name==='accept'?'connected':'idle';return {submitted:true};},async stop(){}};
  const control=new DesktopControl({application:{executable:'/test/app'},platform:'wechat',selfId:'self',audioRoute:{inputName:'tx-virtual',outputName:'rx-virtual'},targets:[{id:'peer',kind:'direct'}],profile,actionTimeoutMs:100,...options},{driver,platform:'linux'});
  control.stopped=false;control.abort=new AbortController();return {control,driver,ui,profile};
}
test('all shipped OS/application semantic profiles validate while disabled until calibrated',async()=>{
  for(const name of await fs.readdir(new URL('./profiles/',import.meta.url)))if(name.endsWith('.json')){const p=JSON.parse(await fs.readFile(new URL('./profiles/'+name,import.meta.url)));validateProfile(p);assert.equal(p.calibrated,false);}
});
test('dial returns actual dialing; connected state requires target and client-side audio evidence',async t=>{
  const f=fixture();t.after(()=>f.control.stop());
  const call=await f.control.control('dial',{kind:'direct',targetId:'peer'},'dial1');assert.equal(call.state,'dialing');assert.deepEqual(f.ui.invocations,['dial']);
  f.ui.phase='connected';f.control.reconcile(await f.control.snapshot());assert.equal(f.control.calls.get(call.id).state,'connected');
  f.ui.route=false;
  await assert.rejects(async()=>f.control.reconcile(await f.control.snapshot()),/exactly one/);
});
test('wrong account, ambiguous target or absent audio route never invokes a call button',async t=>{
  for(const change of [{identity:'other'},{duplicates:true},{route:false},{truncated:true}]){const f=fixture();t.after(()=>f.control.stop());Object.assign(f.ui,change);await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'denied'));assert.equal(f.ui.invocations.length,0);}
});
test('stable request IDs cannot duplicate calls or change their parameters',async t=>{
  const f=fixture();t.after(()=>f.control.stop());const args={kind:'direct',targetId:'peer'};
  const first=await f.control.control('dial',args,'once');assert.equal((await f.control.control('dial',args,'once')).id,first.id);assert.equal(f.ui.invocations.length,1);
  await assert.rejects(f.control.control('dial',{...args,targetId:'another'},'once'),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('incoming call, accept and hangup follow positive observed states',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.ui.phase='ringing';f.control.reconcile(await f.control.snapshot());const call=f.control.active();assert.equal(call.direction,'incoming');
  await f.control.control('accept',{callId:call.id},'answer');assert.equal(f.control.calls.get(call.id).state,'connected');
  await f.control.control('hangup',{callId:call.id},'end');assert.equal(f.control.calls.get(call.id).state,'ended');
});
test('UI disappearance is unknown, not a fabricated hangup; account process restart invalidates call',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.ui.phase='connected';f.control.reconcile(await f.control.snapshot());const call=f.control.active();
  f.ui.phase='missing';
  await assert.rejects(async()=>f.control.reconcile(await f.control.snapshot()),/state matches 0/);
  f.ui.process='200:2000';await f.control.snapshot();assert.equal(f.control.calls.get(call.id).state,'failed');
});
test('unconfirmed invoke remains cleanup-required and never produces connected audio state',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.driver.act=async()=>{f.ui.invocations.push('dial');return {submitted:true};};
  await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'unknown'),e=>e.code==='RESULT_UNKNOWN');assert.equal(f.control.active().state,'ending');assert.equal(f.control.offline,true);
});
test('selector hierarchy and absence conditions require exact unique matches',()=>{
  const nodes=[{id:'1',name:'Window',role:'window',visible:true},{id:'2',name:'Join',role:'button',visible:true,parentId:'1'},{id:'3',name:'Join',role:'button',visible:true}];const snapshot={nodes};
  assert.throws(()=>exactNode(snapshot,{name:'Join'}),/2 controls/);assert.equal(exactNode(snapshot,{name:'Join',ancestor:{name:'Window'}}).id,'2');
  assert.equal(matchesAll(snapshot,{all:[{name:'Window'}],none:[{name:'Connected'}]}),true);assert.equal(matchesAll(snapshot,{all:[{name:'Window'}],none:[{name:'Join'}]}),false);
});
test('state changes during dial preparation cannot accept or displace a different incoming call',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.profile.actions.dial.steps.unshift({kind:'assert',selector:{name:'self'}});
  const original=f.driver.snapshot;let snapshots=0;f.driver.snapshot=async()=>{if(++snapshots===3)f.ui.phase='ringing';return original();};
  await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'late-ring'),e=>e.code==='INVALID_STATE');assert.equal(f.ui.invocations.length,0);
});
test('a missing connected marker does not prevent guarded hangup using verified identity and peer',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.ui.phase='connected';f.control.reconcile(await f.control.snapshot());const call=f.control.active();
  f.ui.phase='unrecognized';f.control.markOffline('unknown UI');assert.equal(f.control.caps.hangup.supported,true);
  await f.control.control('hangup',{callId:call.id},'cleanup');assert.equal(f.control.calls.get(call.id).state,'ended');assert.deepEqual(f.ui.invocations,['hangup']);
});
function preflightFixture(){
  const f=fixture();f.ui.settings=false;
  Object.assign(f.profile,{evidenceMode:'preflight',preflight:[{kind:'invoke',selector:{name:'settings'},waitFor:{name:'self'}},{kind:'verify',field:'identity'},{kind:'verify',field:'audioInput'},{kind:'verify',field:'audioOutput'},{kind:'invoke',selector:{name:'close-settings'}}]});
  const snapshot=f.driver.snapshot,act=f.driver.act;
  f.driver.snapshot=async()=>{const result=await snapshot();result.nodes=result.nodes.filter(n=>f.ui.settings||!['self','tx-virtual','rx-virtual'].includes(n.name));result.nodes.push({id:'settings',name:f.ui.settings?'close-settings':'settings',visible:true,enabled:true,actions:['invoke']});return result;};
  f.driver.act=async(s,n,k,v)=>{if(['settings','close-settings'].includes(n.name)){f.ui.invocations.push(n.name);f.ui.settings=n.name==='settings';return {submitted:true};}return act(s,n,k,v);};
  return f;
}
test('preflight verifies hidden account/routes then closes settings; connected UI need not expose them',async t=>{
  const f=preflightFixture();t.after(()=>f.control.stop());
  const call=await f.control.control('dial',{kind:'direct',targetId:'peer'},'preflight-call');
  assert.deepEqual(f.ui.invocations,['settings','close-settings','dial']);assert.equal(f.ui.settings,false);
  f.ui.phase='connected';f.control.reconcile(await f.control.snapshot());assert.equal(f.control.active().state,'connected');
  f.control.prepared.checkedAt-=3600001;f.control.reconcile(await f.control.snapshot());assert.equal(f.control.active().id,call.id); // Evidence remains tied to this same active call.
  f.ui.phase='idle';f.control.reconcile(await f.control.snapshot());await assert.rejects(f.control.snapshot(),e=>e.code==='DESKTOP_PREFLIGHT_REQUIRED');
  f.ui.invocations=[];await f.control.control('dial',{kind:'direct',targetId:'peer'},'second-call');assert.deepEqual(f.ui.invocations,['settings','close-settings','dial']);
});
test('preflight rejects missing routes, account changes, changed profile and restarted processes',async t=>{
  const f=preflightFixture();t.after(()=>f.control.stop());f.ui.route=false;
  await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'no-route'));assert.equal(f.ui.invocations.includes('dial'),false);assert.equal(f.control.prepared,null);
  f.ui.route=true;f.ui.settings=false;await f.control.prepare();f.control.config.audioRoute.outputName='another-route';await assert.rejects(f.control.snapshot(),e=>e.code==='DESKTOP_PREFLIGHT_REQUIRED');
  f.control.config.audioRoute.outputName='rx-virtual';f.ui.settings=false;await f.control.prepare();f.ui.process='101:other';await assert.rejects(f.control.snapshot(),e=>e.code==='DESKTOP_PREFLIGHT_REQUIRED');
});
test('accept performs fresh preflight even while existing incoming evidence is cached',async t=>{
  const f=preflightFixture();t.after(()=>f.control.stop());f.ui.phase='ringing';f.control.reconcile(await f.control.prepare());const call=f.control.active();f.ui.invocations=[];
  await f.control.control('accept',{callId:call.id},'accept-preflight');assert.deepEqual(f.ui.invocations,['settings','close-settings','accept']);assert.equal(f.control.active().state,'connected');
});
test('meeting entry and in-call identity may use separate exact selectors',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.profile.actions.dial.target={name:'meeting-input',value:'{target}'};f.ui.target='irrelevant-view';
  const snapshot=f.driver.snapshot;f.driver.snapshot=async()=>{const s=await snapshot();if(f.ui.phase==='idle')s.nodes.push({id:'input',name:'meeting-input',value:'peer',visible:true,enabled:true,actions:['setValue']});else s.nodes.find(n=>n.name===f.ui.target).name='peer';return s;};
  const call=await f.control.control('dial',{kind:'direct',targetId:'peer'},'meeting-entry');assert.equal(call.state,'dialing');assert.equal(call.targetId,'peer');
});
test('preflight cannot contain a hidden call commit or omit an evidence class',()=>{
  const f=preflightFixture();f.profile.preflight[0].commit=true;assert.throws(()=>validateProfile(f.profile),/cannot write text or commit/);delete f.profile.preflight[0].commit;f.profile.preflight=f.profile.preflight.filter(s=>s.field!=='identity');assert.throws(()=>validateProfile(f.profile),/must verify/);
});
test('outgoing calls require the exact configured target and kind allowlist',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.control.config.targets=[];
  await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'not-allowed'),e=>e.code==='TARGET_NOT_ALLOWED');assert.equal(f.ui.invocations.length,0);
  f.control.config.targets=[{id:'peer',kind:'group'}];await assert.rejects(f.control.control('dial',{kind:'direct',targetId:'peer'},'wrong-kind'),e=>e.code==='TARGET_NOT_ALLOWED');
});
test('contact picker lists configured direct contacts and meetings without inventing activity',async t=>{
  const f=fixture();t.after(()=>f.control.stop());f.control.config.targets=[{id:'peer',kind:'direct',name:'My contact'},{id:'room',kind:'group',name:'My meeting'}];
  const list=await f.control.channels();assert.deepEqual(list.map(({id,name,kind})=>({id,name,kind})),[{id:'peer',name:'My contact',kind:'direct'},{id:'room',name:'My meeting',kind:'group'}]);assert.equal(list.some(item=>'active'in item),false);
});

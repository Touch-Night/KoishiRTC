#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { AccessibilityDriver } from './driver.mjs';
import { DesktopControl } from './control.mjs';
import { validateProfile, findNodes, matchesAll } from './profile.mjs';
import { spawnSync } from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
export async function initialize(options){
  if(!['wechat','feishu','tencent-meeting'].includes(options.platform))throw Error('Use --platform wechat|feishu|tencent-meeting');
  if(!options.directory||!options.executable||!path.isAbsolute(options.executable)||!options.selfId||!options.input||!options.output||options.input===options.output)throw Error('Specify --directory, absolute --executable, --self-id, and different --input/--output client virtual device names');
  const os=options.os??process.platform, directory=path.resolve(options.directory),port=Number(options.port??6140);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Choose a valid dedicated port');
  const profile=JSON.parse(await fs.readFile(path.join(here,'profiles',`${options.platform}-${os}.json`),'utf8'));validateProfile(profile);
  await fs.mkdir(directory,{mode:0o700});
  const profileFile=path.join(directory,'profile.json'),tokenFile=path.join(directory,'control.token'),configFile=path.join(directory,'bridge.json');
  const config={host:'127.0.0.1',port,tokenFile,account:{platform:options.platform,selfId:options.selfId},desktop:{profileFile,application:{executable:options.executable,...(options.bundleId?{bundleId:options.bundleId}: {})},python:options.python??(os==='win32'?'python':'python3'),audioRoute:{inputName:options.input,outputName:options.output},targets:[]},audio:{backend:os==='linux'?'pulse':'portaudio',...(os!=='linux'?{python:options.python??(os==='win32'?'python':'python3')}:{}),inputDevice:'',outputDevice:'',sampleRate:48000,channels:1,frameMs:20,maxQueueMs:2000}};
  await fs.writeFile(tokenFile,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});await fs.writeFile(profileFile,JSON.stringify(profile,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.writeFile(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
  return {configFile,profileFile,tokenFile,startsProcesses:false,controlsEnabled:false,notes:'Fill explicit media devices, inspect the current app UI, and calibrate profile evidence before enabling controls. Protect this directory with your user-only ACL on Windows.'};
}
export function validateSnapshot(profile,snapshot,variables){
  validateProfile(profile);const report={complete:snapshot.truncated===false,processIdentity:snapshot.processIdentity,states:Object.entries(profile.states).filter(([,condition])=>matchesAll(snapshot,condition,variables)).map(([name])=>name),evidence:{}};
  for(const field of ['identity','target','audioInput','audioOutput'])report.evidence[field]=findNodes(snapshot,profile[field],variables).length;
  report.ready=report.complete&&report.states.length===1&&['identity','audioInput','audioOutput'].every(field=>report.evidence[field]===1)&&(report.states[0]==='idle'||report.evidence.target===1);
  report.enablesControls=false;report.evidenceMode=profile.evidenceMode??'continuous';if(profile.evidenceMode==='preflight')report.note='Read-only snapshot only: hidden identity/audio settings are expected to be absent. Run probe for the explicit settings-navigation verification; this command never invokes controls.';return report;
}
export async function inspectConfig(configFile,{output,target='',validate=false}={}){
  const config=JSON.parse(await fs.readFile(configFile,'utf8')),driver=new AccessibilityDriver(config.desktop);
  try{
    const snapshot=await driver.snapshot();
    if(validate){const profile=config.desktop.profile??JSON.parse(await fs.readFile(config.desktop.profileFile,'utf8'));return validateSnapshot(profile,snapshot,{self:config.account.selfId,target,input:config.desktop.audioRoute.inputName,output:config.desktop.audioRoute.outputName});}
    if(output){await fs.writeFile(output,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});return {file:path.resolve(output),nodes:snapshot.nodes.length,truncated:snapshot.truncated,performsActions:false,containsApplicationText:true};}
    return snapshot;
  }finally{await driver.stop();}
}
export async function probeConfig(configFile){
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  const profile=config.desktop.profile??JSON.parse(await fs.readFile(config.desktop.profileFile,'utf8'));
  const control=new DesktopControl({...config.desktop,platform:config.account.platform,selfId:config.account.selfId,profile:{...profile,calibrated:true}});
  try{const snapshot=await control.prepare();control.verifyRoute(snapshot);return {ok:true,processIdentity:snapshot.processIdentity,evidenceMode:profile.evidenceMode??'continuous',verified:['identity','audioInput','audioOutput'],invokesSettingsOnly:profile.evidenceMode==='preflight',startsCall:false,enablesControls:false};}finally{await control.driver.stop();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),command=args.shift(),options={};const names={'config':'config','directory':'directory','platform':'platform','executable':'executable','self-id':'selfId','python':'python','input':'input','output':'output','out':'out','target':'target','bundle-id':'bundleId','os':'os','port':'port'};
    while(args.length){const key=args.shift()?.replace(/^--/,'');if(!names[key]||!args.length)throw Error('Unknown or incomplete setup option');options[names[key]]=args.shift();}
    let result;
    if(command==='init')result=await initialize(options);
    else if(command==='inspect'||command==='validate')result=await inspectConfig(options.config,{output:options.out,target:options.target,validate:command==='validate'});
    else if(command==='probe')result=await probeConfig(options.config);
    else if(command==='doctor'){const child=spawnSync(options.python??(process.platform==='win32'?'python':'python3'),['-u',path.join(here,'accessibility_worker.py'),'--diagnostics'],{encoding:'utf8',timeout:15000,maxBuffer:16384,windowsHide:true});if(child.status!==0)throw Error('Accessibility dependencies unavailable: '+(child.error?.message??child.stderr));result=JSON.parse(child.stdout);}
    else throw Error('Use init, doctor, inspect, validate or probe; inspect never invokes UI controls');
    console.log(JSON.stringify(result,null,2));
  }catch(failure){console.error(JSON.stringify({ok:false,error:failure.message}));process.exitCode=1;}
}

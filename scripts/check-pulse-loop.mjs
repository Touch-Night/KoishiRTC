// Real isolated PulseAudio loop test: generated tones only; never opens a hardware device.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createAudioBackend } from '../bridge/audio/index.mjs';
const root=path.resolve('runtime/pulse/root'),dir=path.resolve('runtime/pulse/check');
await fs.mkdir(dir,{recursive:true,mode:0o700});
const pulseServer=`unix:${dir}/native`;
const env={...process.env,LD_LIBRARY_PATH:[root+'/usr/lib/aarch64-linux-gnu/pulseaudio',root+'/usr/lib/aarch64-linux-gnu',root+'/usr/lib/pulse-16.1+dfsg1/modules'].join(':'),PULSE_RUNTIME_PATH:dir,PULSE_SERVER:pulseServer};
const script=`.fail\nload-module module-native-protocol-unix socket=${dir}/native auth-anonymous=1\nload-module module-null-sink sink_name=rtc_check_rx rate=48000 channels=1\nload-module module-null-sink sink_name=rtc_check_tx rate=48000 channels=1\nset-default-sink rtc_check_tx\nset-default-source rtc_check_rx.monitor\n`;
await fs.writeFile(path.join(dir,'pulse.pa'),script,{mode:0o600});
const server=spawn(root+'/usr/bin/pulseaudio',['-n','--daemonize=no','--exit-idle-time=-1','--use-pid-file=no','--disable-shm=yes',`--dl-search-path=${root}/usr/lib/pulse-16.1+dfsg1/modules`,`--file=${dir}/pulse.pa`],{env,stdio:['ignore','ignore','pipe']});let stderr='';server.stderr.on('data',d=>stderr=(stderr+d).slice(-3000));
const run=async(command,args)=>{const p=spawn(command,args,{env,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',d=>out+=d);const [code]=await once(p,'exit');if(code)throw new Error(out);return out;};
let audio,monitor,inject;
try {
  let ready=false;for(let i=0;i<50;i++){try{await run(root+'/usr/bin/pactl',['info']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert(ready,stderr);
  audio=createAudioBackend({backend:'pulse',inputDevice:'rtc_check_rx.monitor',outputDevice:'rtc_check_tx',pulseServer,sampleRate:48000,channels:1,pactl:root+'/usr/bin/pactl',parec:root+'/usr/bin/parec',pacat:root+'/usr/bin/pacat'});
  await audio.start();let rx=0,tx=0;
  audio.on('error',e=>console.error('AUDIO ERROR',e.message));
  audio.on('audio',f=>{for(let i=0;i<f.data.length;i+=2)if(Math.abs(f.data.readInt16LE(i))>500)rx++;});
  monitor=spawn(root+'/usr/bin/parec',['--raw','--format=s16le','--rate=48000','--channels=1','--device=rtc_check_tx.monitor'],{env,stdio:['ignore','pipe','ignore']});
  monitor.stdout.on('data',d=>{for(let i=0;i+1<d.length;i+=2)if(Math.abs(d.readInt16LE(i))>500)tx++;});
  await new Promise(r=>setTimeout(r,200));
  const tone=Buffer.alloc(48000);for(let i=0;i<24000;i++)tone.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*3000),i*2);
  inject=spawn(root+'/usr/bin/pacat',['--raw','--format=s16le','--rate=48000','--channels=1','--device=rtc_check_rx'],{env,stdio:['pipe','ignore','pipe']});inject.stdin.end(tone);
  const receipts=[];audio.on('playback',r=>receipts.push(r));
  await audio.write(tone,'loop-tone');await audio.flush();await once(inject,'exit');inject=undefined;
  await new Promise(r=>setTimeout(r,300));assert(rx>1000,`receive samples ${rx}`);assert(tx>1000,`transmit samples ${tx}`);
  assert.equal(receipts.at(-1)?.state,'played');assert.equal(receipts.at(-1)?.playedBytes,tone.length);
  console.log(JSON.stringify({result:'passed',receivedToneSamples:rx,transmittedToneSamples:tx,receipt:receipts.at(-1),scope:'isolated null sinks; no hardware audio'},null,2));
}finally{await audio?.stop();monitor?.kill();inject?.kill();server.kill();await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,1000))]);if(server.exitCode===null)server.kill('SIGKILL');}

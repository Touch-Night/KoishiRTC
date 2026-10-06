<script setup lang="ts">
import { onUnmounted, ref, computed, watch } from 'vue';
import { send } from '@koishijs/client';
const rpc = send as (type: string, ...args: any[]) => Promise<any>;
const props = defineProps<{call:any;capabilities:any;operator:string}>();
const busy=ref(false),error=ref(''),state=ref<any>({tracks:[],sending:{}}),sources=ref<any[]>([]);
const participant=ref(''),kind=ref('camera'),source=ref(''),framing=ref('full'),selectedTrack=ref(''),frameUrl=ref(''),frameTime=ref(0);
let timer:ReturnType<typeof setTimeout>|undefined,stopped=false,generation=0,contextGeneration=0,lastSequence=-1;
const owned=computed(()=>!props.call.owner||props.call.owner===props.operator);
const supported=computed(()=>props.capabilities?.receiveVideo?.supported);
const sourceOptions=computed(()=>sources.value.filter(s=>s.kind===kind.value));
const canSend=computed(()=>props.capabilities?.[kind.value==='camera'?'sendVideo':'shareScreen']?.supported);
const canFrame=computed(()=>kind.value==='camera'&&source.value==='external-frames');
const api=(action:string,args:any={},callId=props.call.id)=>rpc('rtc/video',action,{callId,...args});
const identity=(track:any)=>track.participantId;
const trackName=(track:any)=>(props.call.participants.find((p:any)=>p.id===identity(track))?.name||identity(track)||'未知成员')+' · '+(track.kind==='camera'?'摄像头':'屏幕');
const current=(epoch:number,callId:string)=>!stopped&&epoch===contextGeneration&&callId===props.call.id&&props.call.state==='connected'&&owned.value;
function clearFrame(){if(frameUrl.value)URL.revokeObjectURL(frameUrl.value);frameUrl.value='';frameTime.value=0;lastSequence=-1;}
function clearPreview(){const trackId=selectedTrack.value;selectedTrack.value='';generation++;clearTimeout(timer);clearFrame();return trackId;}
function cleanup(callId:string,trackId:string){if(trackId)void api('unsubscribe',{trackId},callId).catch(()=>{});}
async function action(work:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';const epoch=contextGeneration;try{await work();}catch(e){if(!stopped&&epoch===contextGeneration)error.value=String(e);}finally{busy.value=false;}}
async function poll(epoch:number,callId:string,trackId:string){
 try{
  if(stopped||epoch!==generation||!owned.value||props.call.id!==callId||props.call.state!=='connected'||selectedTrack.value!==trackId)return;
  const result=await api('frame',{trackId},callId);if(stopped||epoch!==generation)return;
  if(result.error)error.value=result.error;
  if(result.ended){error.value=result.error||'视频预览已结束，可重新选择观看。';clearPreview();return;}
  const frame=result.frame,age=frame?Date.now()-frame.timestamp:Infinity;
  if(frame&&frame.callId===callId&&frame.trackId===trackId&&frame.sequence>lastSequence&&frame.encoding==='jpeg'&&age>=-1000&&age<3000){
   const bytes=Uint8Array.from(atob(frame.data),(v:string)=>v.charCodeAt(0));
   const next=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));if(frameUrl.value)URL.revokeObjectURL(frameUrl.value);
   frameUrl.value=next;frameTime.value=frame.timestamp;lastSequence=frame.sequence;
  }else if(frameTime.value&&Date.now()-frameTime.value>3000){clearFrame();}
 }catch(e){if(epoch===generation){error.value=String(e);cleanup(callId,clearPreview());}}
 finally{if(!stopped&&epoch===generation&&selectedTrack.value===trackId)timer=setTimeout(()=>poll(epoch,callId,trackId),200);}
}
async function watchTrack(){await action(async()=>{
 const callId=props.call.id,context=contextGeneration,previous=clearPreview();
 if(previous)await api('unsubscribe',{trackId:previous},callId);
 if(!current(context,callId))return;
 const track=await api('subscribe',{participantId:participant.value,kind:kind.value},callId);
 // A native subscription can finish after navigation, release or unmount.
 if(!current(context,callId)){cleanup(callId,track.trackId);return;}
 selectedTrack.value=track.trackId;void poll(generation,callId,track.trackId);
 const result=await api('state',{},callId);if(current(context,callId))state.value=result;
});}
async function stopPreview(){await action(async()=>{const callId=props.call.id,id=clearPreview();if(id)await api('unsubscribe',{trackId:id},callId);});}
async function inspect(){await action(async()=>{
 const callId=props.call.id,context=contextGeneration;
 if(supported.value){const result=await api('state',{},callId);if(!current(context,callId))return;state.value=result;}
 if(props.capabilities?.sendVideo?.supported||props.capabilities?.shareScreen?.supported){const result=await api('sources',{},callId);if(!current(context,callId))return;sources.value=result;}
 if(!sourceOptions.value.some(s=>s.id===source.value))source.value='';
});}
async function sending(actionName:'send'|'stop'){await action(async()=>{
 const callId=props.call.id,context=contextGeneration,result=await api(actionName,{kind:kind.value,...(actionName==='send'?{sourceId:source.value,...(canFrame.value?{framing:framing.value}:{})}:{})},callId);
 if(current(context,callId))state.value=result;
});}
watch(()=>[props.call.id,props.call.state,props.call.owner],(next,previous)=>{
 if(next[0]!==previous[0]||next[1]!=='connected'||!owned.value||(previous[2]===props.operator&&next[2]!==props.operator)){
  contextGeneration++;cleanup(previous[0],clearPreview());state.value={tracks:[],sending:{}};sources.value=[];source.value='';framing.value='full';participant.value='';error.value='';
 }
});
watch(kind,()=>{source.value='';});
watch(source,()=>{framing.value='full';});
onUnmounted(()=>{stopped=true;contextGeneration++;cleanup(props.call.id,clearPreview());});
</script>
<template>
 <details v-if="supported||capabilities?.sendVideo?.supported||capabilities?.shareScreen?.supported" class="video-panel">
  <summary>视频与屏幕共享</summary>
  <p v-if="!owned" class="hint">当前由其他插件或窗口控制。</p>
  <template v-else>
   <div class="choices">
    <label>视频类型<select v-model="kind"><option value="camera">摄像头</option><option value="screen">屏幕共享</option></select></label>
    <label v-if="supported">观看成员<select v-model="participant"><option value="" disabled>选择成员</option><option v-for="p in call.participants" :key="p.id" :value="p.id">{{p.name||p.id}}</option></select></label>
   </div>
   <div class="buttons"><button v-if="supported" :disabled="busy||!participant||call.state!=='connected'" @click="watchTrack">观看画面</button><button v-if="selectedTrack" :disabled="busy" @click="stopPreview">停止观看</button><button :disabled="busy||call.state!=='connected'" @click="inspect">刷新视频状态与来源</button></div>
   <div v-if="selectedTrack" class="preview"><img v-if="frameUrl" :src="frameUrl" alt="通话对方实时画面"/><p v-else>等待此成员的视频帧…</p><span v-if="frameTime">实时画面 · {{new Date(frameTime).toLocaleTimeString()}}</span></div>
   <div v-if="state.tracks?.length" class="tracks"><span v-for="track in state.tracks" :key="track.trackId">{{trackName(track)}} · {{track.available===false?'已关闭':track.hasFrame?'已收到画面':track.subscribed?'已订阅':'可订阅'}}</span></div>
   <template v-if="canSend">
    <label>发送来源<select v-model="source"><option value="" disabled>先刷新来源，再明确选择</option><option v-for="s in sourceOptions" :value="s.id" :key="s.id">{{s.name}}</option></select></label>
    <label v-if="canFrame">画幅<select v-model="framing"><option value="full">完整画幅</option><option value="portrait-safe">手机竖屏留边</option></select></label>
    <p v-if="canFrame" class="hint">选择后点击发送按钮应用。竖屏留边把内容缩到中间安全区，便于手机 QQ 竖屏观看。</p>
    <div class="buttons"><button :disabled="busy||!source||call.state!=='connected'" @click="sending('send')">{{kind==='camera'?'通过摄像头渠道发送':'通过屏幕共享渠道发送'}}</button><button :disabled="busy||call.state!=='connected'" @click="sending('stop')">停止{{kind==='camera'?'摄像头':'共享'}}</button></div>
    <p class="hint">{{state.sending?.[kind]?.state==='sending'?'发送渠道已开启，请由通话对方确认收到画面。':'仅发送你明确选择的来源。'}}</p>
    <p v-if="sourceOptions.find(s=>s.id===source)?.sourceType==='frames'" class="hint">画面由消费插件通过 writeVideo 提供；开启渠道后等待该插件送入帧，不会自动抓取桌面。</p>
   </template>
   <p v-if="error" role="alert" class="error">{{error}}</p>
  </template>
 </details>
</template>
<style scoped>
.video-panel{border-top:1px solid color-mix(in srgb,currentColor 15%,transparent);margin-top:18px;padding-top:14px}summary{cursor:pointer;font-weight:600;min-height:34px}label{font-size:12px;display:block;margin:12px 0}.choices{display:grid;grid-template-columns:1fr 1fr;gap:12px}select{display:block;width:100%;margin-top:7px;min-width:0;font:inherit;font-size:14px;padding:10px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;color:inherit;background:var(--k-color-surface,Canvas)}.buttons{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);padding:10px 12px;border-radius:8px;min-height:42px;cursor:pointer}button:disabled{opacity:.4;cursor:default}.preview{position:relative;background:#111820;border-radius:12px;overflow:hidden;min-height:160px;margin-top:14px;display:grid;place-items:center;color:#fff}.preview img{width:100%;max-height:480px;object-fit:contain;display:block}.preview span{position:absolute;bottom:8px;left:8px;background:#0009;border-radius:4px;padding:3px 7px;font-size:11px}.tracks{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;overflow-wrap:anywhere;margin:10px 0}.hint{opacity:.7;font-size:12px}.error{color:#bd5353;overflow-wrap:anywhere}@media(max-width:520px){.choices{grid-template-columns:minmax(0,1fr);gap:0}}
</style>

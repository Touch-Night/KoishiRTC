# 插件服务 API

消费插件声明 `export const inject = ['rtc']`，并用 `import type {} from 'koishi-plugin-rtc-bridge'` 引入 Koishi Context 类型扩展。

## 后端与控制权

`ctx.rtc.manager.listProviders()` 返回账号、实际能力及发送音频格式；`listCalls()` 返回通话快照。不要由某个平台名称推断它能拨号或接听，应检查 `capabilities`。

例如 KOOK 只有推流，不提供接收音频；Telegram 私聊的视频双路能力受原生库限制；微信、飞书、腾讯会议桌面后端只有通过账号、目标和音频线路校验后才开放媒体。`channels()` 可以返回已配置联系人或会议，也可能返回服务器语音频道，不应把列表出现等同于正在通话。按条目的 `kind` 区分私聊与群组，显示提供的名称。

`const control = ctx.rtc.controller(ctx, '插件名称')` 创建绑定消费插件生命周期的控制句柄。插件卸载时清理该句柄的播放队列、中止音视频订阅并停止本句柄的视频发送。释放控制权不等于挂断；需要结束通话时先显式 `hangup()`。Discord 后端本身卸载会退出频道；桌面网络中断至少停止媒体，客户端实际通话仍需核对。

每路通话只能由一个句柄控制。名称只是显示信息，同名句柄不能冒用其他句柄的控制权。管理员控制台也是普通控制者，没有隐式抢占别的插件。

```ts
control.claim(callId)                         // 已存在的来电/通话
await control.accept(callId)                  // 只有 ringing 来电
await control.reject(callId)
await control.hangup(callId)                  // 群语音相当于退出
await control.setMuted(callId, true)          // 静音本端输出，仍接收声音
await control.clearAudio(callId)              // 丢弃尚未播放/发送的回复
await control.release(callId)                // 让其他插件取得控制

const call = await control.dial(providerId, {
  kind: 'group', targetId: voiceChannelId, guildId,
}, signal)
```

QQ 主动创建群通话须检查 `capabilities.startGroup`，然后显式指定 `groupMode: 'create'`；`inviteeIds` 使用受邀群成员的 QQ 号码字符串，桥接核实并转换为原生 UID。`groupMode: 'join'` 表示选择已有活跃房间，检查 `joinGroup`；`join` 不能携带邀请名单。其他平台按自己的后端能力处理，不假设两种群操作等价。

私聊默认为 `media: 'audio'`。主动视频邀请使用 `control.dial(providerId, { kind: 'direct', targetId, media: 'video' })`，与语音邀请一样检查 `dial` 能力。这个操作仅发出邀请，不自动选中或打开物理摄像头；接通后，消费插件另行调用 `sendVideo(callId, { kind: 'camera', sourceId })` 明确选择来源，也可选择 `external-frames` 后通过 `writeVideo` 提供 JPEG。

显式的屏幕共享邀请使用 `control.dial(providerId, { kind: 'direct', targetId, media: 'screen' })`，并检查独立能力 `dialScreen`；不能用接通后的 `shareScreen` 代替这个拨号能力。`media: 'video'` 和 `media: 'screen'` 都不用于群通话，也不会自动升级已有语音通话。QQ 普通私聊场景不支持屏幕发送，应新建明确的屏幕共享邀请；接通后仍需选择 `sendVideo` 来源。控制台的“邀请类型”提供语音、视频、屏幕共享三个选项，默认仍是语音。

`dial()` 返回可追踪的通话，不保证已经接通；监听快照中的 `state === 'connected'`。QQ 控制请求返回“submitted”也不能解释为对方已接听。取消信号仅在未提交前保证不执行，网络断开或超时可能意味着结果未知，不要盲目重试拨号。平台回调决定最终状态。

## 连续音频

统一数据是 `AudioFrame`：

```ts
{
  callId, sequence, timestamp, // 毫秒时间戳
  sampleRate: 48000,
  channels: 1,                // 或 2；查看后端 audioFormat
  encoding: 'pcm_s16le',
  data: Uint8Array,
  speakerId?: string
}
```

建议每帧 20 ms；单帧不得超过一秒，必须对齐完整 PCM 帧。Discord 发送要求 48 kHz 双声道；桌面桥使用其配置的格式。需要 16/24 kHz 的识别或合成服务应由消费插件重采样，不能只修改采样率字段。

```ts
const abort = new AbortController()
try {
  for await (const frame of control.audio(callId, {
    signal: abort.signal,
    maxBufferMs: 2000,
  })) {
    await recognizer.write(frame) // 自己的 STT / Realtime 实现
  }
} catch (error) {
  // ABORTED / AUDIO_OVERFLOW / 通话结束；关闭本次识别会话
}
```

每个迭代器只能消费一次。缓冲溢出会终止这条订阅，避免丢失部分内容后仍把剩余片段当完整对话。释放控制权、插件卸载、通话结束都会终止对应订阅。收到的音频不写入磁盘，也不塞进通话历史。

Discord 的 `speakerId` 来自平台音轨映射。QQ 虚拟音频收到的是混音，没有 `speakerId`；参与者列表不代表知道当前是谁说话。QQ 成员 ID 为原生 UID，不能当作数字 QQ 号。

## 播放与打断

```ts
const receipt = await control.writeAudio(callId, {
  sequence: 0, timestamp: Date.now(),
  sampleRate: 48000, channels: 1, encoding: 'pcm_s16le', data,
}, '本次回复-第一个片段')
```

回执字段：

| 字段/状态 | 含义 |
| --- | --- |
| acceptedBytes / queued | 后端接受的数据量，不代表已播放 |
| playing | 本地输出开始；可能仍有未确认数据 |
| playedBytes / played | 本地音频设备已按其 drain 或 DAC 时钟确认 |
| dispatchedBytes / dispatched | 后端已提交媒体或网络发送，不表示远端扬声器已播放 |
| cancelled / failed | 尚未完成的部分被取消或失败 |
| evidence | `pulse-stream-drained`、设备时钟或 `discord-udp-dispatch` 等具体依据 |

监听 `ctx.rtc.manager.on('playback', handler)` 接收后续回执。监听器应在自己的 `ctx.on('dispose')` 中移除。任何本地回执都不证明远端用户确实听见，需要应用层确认或实测。

打断时先取消上游生成，再调用 `clearAudio()`。已经发到远端或已经进入设备的音频不能撤回。`setMuted(true)` 也会清掉待播放内容，取消静音不会恢复旧队列。

## 接收视频

先检查 `receiveVideo`、取得控制权并等待 `connected`，再明确选择当前成员的 `camera` 或 `screen` 轨道。QQ 成员使用快照中的原生 UID，不能自行把 QQ 号当作成员 ID。

```ts
const track = await control.subscribeVideo(callId, {
  participantId: selectedParticipantId,
  kind: 'camera',
})
try {
  for await (const frame of control.video(callId, track.trackId, { signal })) {
    await preview.renderJpeg(frame.data, frame.width, frame.height)
  }
} finally {
  // 迭代器结束/abort 会撤销最后一个读取者对应的原生订阅。
  // 没有开始读取，或需要主动停止时，调用 unsubscribeVideo。
}
```

`VideoFrame` 包含 `callId`、`trackId`、`participantId`、`kind`、`encoding: 'jpeg'`、`width`、`height`、`sequence`、毫秒 `timestamp`、`data: Uint8Array` 和接收证据 `evidence`。证据只接受两种值：`native-first-frame-and-render-capture` 表示当前授权订阅收到原生首帧通知并成功截取渲染画面；`native-decoded-size-change-and-render-capture` 表示当前订阅收到真实解码帧的尺寸变化通知并成功截取画面。后者用于原生渲染缓存跨通话复用、没有重新发首帧通知的情况，不会冒充首帧通知。JPEG 上限为 256 KiB。公共轨道字段是 `trackId` / `participantId`，与 QQ Host 内部 `id` / `uid` 字段区分。

`VideoTrack.firstFrameAt` 仅记录原生首帧通知；可选的 `decodedFrameAt` 记录当前授权订阅的解码帧证据时间（首帧或真实尺寸变化通知）。未收到相应证据时为 `null`，旧后端可省略。仅有这些通知不代表已取得 JPEG；实际帧仍须通过渲染截取和身份、序号校验。

每通最多四路订阅，每路最多八个读取者。每个读取者只保留最新一帧，慢消费者丢弃旧画面，不阻塞 PCM。成员离开、通话结束、释放控制权、桥接断连或消费插件卸载会撤销读取与缓冲。画面不写入通话历史或磁盘。

```ts
const state = await control.videoState(callId)
await control.unsubscribeVideo(callId, trackId)
```

`VideoState` 返回当前 `callId`、`supported`、`tracks`、按发送渠道索引的 `sending` 及可选 `lastError`。存在轨道、原生订阅成功、收到首帧是不同的状态，不能把订阅 ACK 当作已收到画面。

## 视频来源与发送渠道

`camera` 和 `screen` 表示平台发送渠道。视频来源由消费插件或用户选择，并不限于物理摄像头或桌面捕获。

```ts
const sources = await control.videoSources(callId)
// 展示 sources 后，由调用者明确选择 sourceId 和发送渠道。
await control.sendVideo(callId, { kind: 'screen', sourceId: selectedSourceId })
await control.stopVideo(callId, 'screen')
```

外部帧的摄像头渠道可选 `framing: 'full' | 'portrait-safe'`，省略时为 `full`：

```ts
await control.sendVideo(callId, {
  kind: 'camera', sourceId: 'external-frames', framing: 'portrait-safe',
})
```

`full` 使用完整输出画幅；`portrait-safe` 将输入内容等比缩小、居中到 9:16 安全区并留边，以应对手机 QQ 竖屏观看时的中央裁切。它不能强制手机横屏，也不会改变会话或输入 JPEG。只有 `camera` + `external-frames` 接受这个参数，其他来源和屏幕渠道携带它会被拒绝。`VideoState.sending.camera.framing` 回显已确认模式；后端没有确认所选留边模式时报告错误。

再次开启同来源、同画幅保留帧序号；显式切换画幅会重新配置该渠道，等待回执后可为新一轮输入从 0 开始编号。控制台提供“完整画幅 / 手机竖屏留边”选项，只有再次点击发送按钮才应用，不会随选项变化自动操作通话。

`VideoSource` 保留 `id`、`name`、`kind`（此条来源可用的发送渠道）；可额外声明 `sourceType: 'device' | 'window' | 'frames' | 'generated'` 和 `channels`。同一个来源可以为两个渠道各列一条。设备、窗口和合成来源的实现由具体后端负责，公共 API 不自动选择物理设备。旧后端没有 `sourceType` 时仍可选择其来源，但不能假设支持帧写入。

消费插件提供的视频帧须先通过 `sendVideo` 开启对应渠道的 `sourceType: 'frames'` 来源，再写入 JPEG。屏幕渠道的 `external-frames` 来源由 QQ Host 渲染到它自己的独立窗口，不抓取用户桌面；相机渠道仅在后端已配置并检查到虚拟设备后才会枚举该来源；开启时还会验证原生 QQ 能否枚举并打开它，未通过则报告失败。

```ts
await control.sendVideo(callId, { kind: 'screen', sourceId: 'external-frames' })
try {
  for await (const jpeg of generatedFrames) {
    const receipt = await control.writeVideo(callId, {
      kind: 'screen', encoding: 'jpeg',
      width: jpeg.width, height: jpeg.height,
      sequence: jpeg.sequence, timestamp: jpeg.timestamp,
      data: jpeg.data, // Uint8Array；由消费插件生成或取得
    })
    // 检查 receipt，不把本端提交/渲染视作对方已看到画面。
  }
} finally {
  await control.stopVideo(callId, 'screen')
}
```

发送单帧最多 256 KiB、2073600 像素且每边不超过 4096，支持横向或纵向全高清。序号在该次来源启动期间严格递增；重复开启同一已发送来源不会重置序号。每个发送渠道只保留一个正在提交的帧和一个最新待发帧，旧待发帧得到 `dropped` 回执。帧写入不进入通话控制请求的重试账本；失败或结果未知时不自动重放旧帧。

`VideoWriteReceipt` 包含 `callId`、`kind`、`sequence`、`state`、`evidence`、可选 `acceptedBytes` / `error`；状态为 `accepted`、`rendered`、`submitted`、`dropped` 或 `failed`。这些状态只说明对应的本端处理阶段，`sendVideo` 的原生 ACK 也不证明远端收到。停止来源、释放控制权、断连或插件卸载会丢弃待发帧并清理发送；不等同于挂断通话。

目前 QQ 原生视频实现仅针对已核对画像的 Linux；ARM64 正在真实通话验收，不能把静态 ABI、离线帧回归或本端渲染回执称作远端视频验收通过。Windows / macOS 的音频支持不代表视频已实现。

## 扩展平台

实现 `CallProvider` 后 `await ctx.rtc.register(ctx, provider)`。接口位于公开的 `./core` 导出；后端通过 `provider.events.emit('event', event)` 发布 `call`、`audio`、`video`、`playback`、`availability`、`error`。可选的视频方法包括 `videoState`、`videoSources`、`subscribeVideo`、`unsubscribeVideo`、`sendVideo`、`stopVideo`、`writeVideo` 和内部资源清理 `clearVideo`；未实现时必须关闭对应能力。

必须采用真正的平台账号标识、唯一通话 ID、实际连接回调和有界队列。未实现或无法确认的能力返回 `supported:false` 及原因。不要把发送语音消息伪装成实时通话。桌面桥网络与平台调用的回执必须分别处理。

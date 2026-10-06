# Telegram 普通账号 RTC 后端

这是独立于 QQ 的 Telegram MTProto + PyTgCalls/NTgCalls 后端。先按 [安装与登录](telegram-setup.md) 安装隔离 Python 环境、由账号所有者完成一次普通用户登录，再启用 Koishi 配置。它不使用 Telegram Bot API，Bot token 不能用于私聊电话。

```yaml
telegram:
  - id: telegram-calls
    selfId: '123456789'
    python: /absolute/path/KoishiRTC/runtime/telegram-venv/bin/python
    configPath: /absolute/path/KoishiRTC/runtime/telegram/config.json
    allowedChatIds:
      - '234567890'
      - '-1001234567890'
    maxQueueMs: 2000
```

Windows 的 `python` 填虚拟环境 `Scripts/python.exe` 的绝对路径。`configPath` 必须是绝对路径；该私密 JSON 保存 `apiId`、`apiHash`、同一个 `selfId` 和绝对 `.session` 路径。Node 只向自有 Python 子进程传递配置文件路径，凭据不出现在命令行参数里。会话目录和配置必须放在 `runtime` 或包外私有目录中，不能放进源码或分发包。

默认空白名单不开放通话。`allowedChatIds` 使用普通用户的正数字 ID、群/超级群的负数字 ID（超级群常以 `-100` 开头），不接受手机号或 `@username`。账号必须已经能解析和访问对应用户/群；本插件不负责加入新群、发送消息或批量邀请人。启动只加载已有授权会话并核验实际用户 ID，后台不会弹出登录或自动拨打/接听。

控制台目标列表由 `channels()` 返回上述白名单及 `direct`/`group` 类型，显示“Telegram 用户/群 + ID”。它不读取整个联系人/群列表，也不把本地标签伪装成真实 Telegram 昵称。

## 通话接口

使用现有 `ctx.rtc.controller(ctx, owner)`，明确选择 provider、目标和已连接的 callId；完整租约、音视频订阅示例见 [公共 API](api.md) 和 `examples/video-consumer.ts`。

```ts
const control = ctx.rtc.controller(ctx, 'my-consumer')
// 普通私聊语音。media: 'video' / 'screen' 可显式声明视频邀请，
// 只连接外部媒体入口，不打开任何物理设备或抓取桌面。
const call = await control.dial('telegram-calls', {
  kind: 'direct', targetId: '234567890', media: 'audio',
})
// 群：join 不创建不存在的群通话；create 明确允许创建，受 Telegram 权限限制。
const group = await control.dial('telegram-calls', {
  kind: 'group', targetId: '-1001234567890', groupMode: 'join',
})
```

两次拨号是独立示例；一个 Telegram 后端同一时间只允许一个未结束的通话。来电仅向消费插件报告 `ringing`，由其取得控制权后显式 `accept` 或 `reject`。群的 `hangup`/`leaveGroup` 只离开当前通话，不关闭整个群语音。网络或 sidecar 断开会撤销当前通话和媒体能力，结束自有原生媒体资源；必须显式重启后端并重新选择通话，不重拨旧目标。

## 音频、视频与回执

- 双向音频是 48 kHz、双声道、PCM S16LE。任意帧对齐的公共音频会在有限队列中组装为 SDK 要求的 10 毫秒块；队列默认最多 2 秒。`clearAudio`/静音丢弃未提交数据并等待在途提交结束。
- `dispatched`、`dispatchedBytes` 和 `evidence: 'ntgcalls-input-submit'` 只表示输入交给原生 SDK，`playedBytes` 始终是 `0`。不证明 UDP 送达或对方听到；已经交给 SDK 的音频不能撤回。中间 `playing` 状态只表示队列正在处理，不能据此推断远端播放进度。
- 群音频将同一 SDK 更新的多个说话人 PCM 混音，`speakerIdentity` 为不支持；没有把 SSRC 猜作用户 ID。成员列表来自 Telegram 群通话参与者数据。
- `videoSources` 对 `camera`、`screen` 分别返回 `external-frames`。消费插件明确 `sendVideo` 后，使用公共 `writeVideo` 传入 JPEG；不枚举/打开本机设备，不抓桌面。群通话可同时配置两路；NTgCalls 3.0.1 的普通私聊只允许摄像头或屏幕其中一路，切换前必须先停止当前渠道。默认等比缩放到 640×360 I420，摄像头可选 `portrait-safe` 留边。SDK 回执 `submitted` / `ntgcalls-i420-input-submit` 不代表对方已看到。
- 接收视频按当前 callId、真实成员和 `camera`/`screen` 显式订阅，最多四路；群视频通过原生 SSRC 与 Telegram 成员公布的 source groups 精确对应，无法对应的帧会丢弃。SDK 解码的 I420 转换为不超过 256 KiB 的 JPEG，证据为 `ntgcalls-decoded-frame-and-jpeg-encode`，`decodedFrameAt` 为实际解码帧时间，`firstFrameAt` 不伪造 QQ 首帧通知。取消、成员离开、终止和卸载会撤销输出。

后续启停视频和订阅只配置当前原生通话，不调用会在通话消失时自动新建的上游便捷方法。所有输入来源都是 `MediaSource.EXTERNAL`；消费插件未发送媒体时不会回退到真实麦克风/摄像头。

## 当前验证范围与平台

2026-10-06 已在 Linux ARM64 / Python 3.12 安装并加载官方 NTgCalls 3.0.1 wheel，完成原生对象构造/释放和内存 JPEG 编解码；另在无 MTProto 客户端、无信令或远端的本地原生对象中实际提交 10 毫秒 PCM 与 I420，验证私聊双路发送被 SDK 拒绝，停止后原生通话表为空。离线回归覆盖账号校验、白名单、来电/拨号信令路径、10 毫秒发送、队列/清理、视频成员映射与生命周期。**没有 Telegram 账号在线验收，尚未证明 Telegram 服务端、账户权限、NAT、私聊对端或群通话的真实连接与媒体效果。**

NTgCalls 3.0.1 发布的 wheel 覆盖 Linux glibc 2.28+ 的 x86_64/aarch64、Windows AMD64，以及 macOS 14+ ARM64，CPython 3.10–3.14。该版本的[官方平台矩阵](https://github.com/pytgcalls/ntgcalls/blob/v3.0.1/README.md)明确将 macOS Intel 标为 unsupported；[WebRTC 构建依赖选择](https://github.com/pytgcalls/ntgcalls/blob/v3.0.1/cmake/FindWebRTC.cmake)仅有 `MACOS_ARM64`，其他 macOS 架构直接报不支持。因此本轮没有给 Intel Mac 提供未经证实的源码编译命令，也不宣称支持；它不影响本项目独立的 QQ macOS 后端。Android 不是这个桌面 Python 部署的目标。

准备在线验收时，依次检查：登录与 `selfId`、白名单中另一个自有测试账号的来电/接听/拒接/挂断、主动私聊、现有群加入与离开、双向 PCM、显式两路外部 JPEG、断网与消费插件释放。创建群通话和视频邀请应分别由用户明确选择；不需要在开发实现过程中提前登录或拨号。

## 依据

固定使用 [PyTgCalls 3.0.0](https://github.com/pytgcalls/pytgcalls)、[NTgCalls 3.0.1](https://github.com/pytgcalls/ntgcalls/tree/v3.0.1) 和 [Telethon](https://docs.telethon.dev/en/stable/)。官方 [外部音频发送示例](https://github.com/pytgcalls/pytgcalls/blob/master/example/frame_sending/example_frame_sending.py) 和 [双向外部帧示例](https://github.com/pytgcalls/pytgcalls/blob/master/example/bridged_calls/example_bridged.py) 展示 `send_frame` / `RecordStream`；实际实现同时核对了 `play.py`、`connect_call.py`、`leave_call.py` 与 NTgCalls `audio_streamer.cpp` / `video_receiver.cpp` 的源码，避免便捷方法隐式重拨和错误的媒体帧格式。TS 与 sidecar 使用本地 JSONL 协议，无额外监听端口。

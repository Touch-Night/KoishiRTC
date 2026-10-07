# 桌面媒体桥

QQ 控制桥负责平台登录态、通话命令及事件；媒体桥负责连接它与音频设备，并转发独立的视频订阅、JPEG 帧和显式来源发送。Koishi 可以在同一台机器，也可通过 SSH 隧道连接另一台有 QQ 客户端的电脑。

默认端口各不相同：QQ 控制桥 6110，原生 AV Host 6111，媒体桥 6120。开发验收环境使用另外一组端口，不能直接混用其配置。

## 配置

先准备[两条独立虚拟音频线路](audio-setup.md)。创建仅本用户可读的 `bridge.json`；令牌文件至少 32 字节，不要提交到代码库。

```json
{
  "host": "127.0.0.1",
  "port": 6120,
  "tokenFile": "/absolute/path/media.token",
  "account": { "platform": "onebot", "selfId": "实际登录的QQ号" },
  "qq": {
    "url": "http://127.0.0.1:6110",
    "tokenFile": "/absolute/path/control.token"
  },
  "audio": {
    "backend": "pulse",
    "pulseServer": "unix:/absolute/path/qq-bridge/runtime/pulse/native",
    "inputDevice": "koishi_rtc_qq_speaker.monitor",
    "outputDevice": "koishi_rtc_qq_mic",
    "sampleRate": 48000,
    "channels": 1,
    "frameMs": 20,
    "maxQueueMs": 2000
  }
}
```

Windows/macOS 改用 `backend: "portaudio"`，填写 `python`（虚拟环境解释器绝对路径）及设备枚举中显示的确切 ID。必须先使 AV Host 本身选择对应的虚拟扬声器/麦克风；桌面 QQ 的设备设置未必会被独立 Host 继承。

```sh
node bridge/daemon.mjs /absolute/path/bridge.json
```

然后在 Koishi 插件配置的桌面桥接列表中填写唯一名称、`ws://127.0.0.1:6120/v1/stream`、媒体令牌、`onebot` 和同一实际 QQ 号。桥接会比较 NapCat 报告的账号，配置标签不能代替实际身份验证。

## 控制台操作

在“实时通话”中运行连接检查，展开能力可查看不可用原因。设备可以点选；保存会原子写回桥接配置。已有通话时拒绝更改路由。断开设备不会改用默认麦克风。

音频只在平台确认接通、设备诊断通过且有已认证的 Koishi 连接时开始。失去连接、结束通话或设备出错时停止媒体；重新配置后显式检查连接才重新启用。健康检查不录音。

群语音下拉菜单来自 QQ 最近报告的活跃语音房间；没有报告或已过期的房间不能假装可加入。QQ 原生接口没有原子的“仅加入、绝不创建”选项，查到活跃房间后它仍可能恰好结束；上层需要理解这个平台限制。

## 视频预览与发送

面板的“视频与屏幕共享”按后端实际能力显示。先接通通话，再选择当前成员和视频类型，点击观看。预览仅保留最新 JPEG；停止观看会取消此轨道订阅并删除缓存画面，不挂断通话。参与者离开、关闭预览面板所在组件或切换通话后，不保留迟到订阅。

新建私聊时，默认“语音通话”；只有后端声明 `dialScreen` 才能选择“屏幕共享通话”发出邀请。WebUI 的视频/屏幕邀请会在拨号前要求选择来源，接通后通过 `initialVideo` 自动开始发送。已有通话请使用通话内的视频按钮：摄像头可直接开启；已审计的 QQ Linux ARM64 构建可经官方 DAV→MAV 转换开启屏幕共享，保留逻辑通话与控制权，展示 `mediaTransition`，原生音频可能短暂停顿。其他构建不冒充支持未验证的转换。

发送必须先刷新来源，再明确选择。`camera` / `screen` 是发送渠道，来源可来自设备、窗口、合成图案或消费插件生成的视频。选择 `external-frames` 并开启后，消费插件通过 `ctx.rtc` 的 `writeVideo()` 提供 JPEG；不会自动抓取桌面。没有匹配的已验证设备时，不会回退到默认摄像头。

停止观看与停止发送分别操作。释放控制权、控制台断连、权限过期和插件卸载会清理该控制者的订阅及发送，并丢弃待发送帧；当前通话可以继续供其他控制者使用。迟到的预览轮询或取消请求不能重新取得已释放的控制权。

Koishi 服务与媒体桥之间的内部 WebSocket 操作是 `video.state`、`video.sources`、`video.subscribe`、`video.unsubscribe`、`video.send`、`video.stop`、`video.write`、`video.clear`，接收帧为 `type: 'video'`。JSON 中 JPEG 使用 base64，公开插件 API 使用 `Uint8Array`。帧上限 256 KiB；发送与接收队列均有界，视频不占用音频控制队列。`video.write` 以单调帧序号防止旧帧重放，不缓存整个帧请求到控制命令账本。

QQ Host 的 `supported`、`sendSupported`、`shareScreenSupported` 决定视频能力；状态探测失败不应把已正常工作的语音标为离线。来源列表仅在显式刷新或开启来源时枚举。订阅首帧、原生发送 ACK、本端窗口渲染和远端实际看到画面分别记录，不能互相代替。

当前视频只开放已静态核对的 Linux QQ 原生画像，ARM64 正在实机验证；Windows / macOS 不能仅凭音频后端工作便宣称视频可用。

## 远程主机

媒体服务只监听 loopback。优先使用 SSH 本地端口转发；也可自行配置只面向可信客户端的 TLS 反向代理。直接远程 `ws://` 会被插件拒绝。令牌通过 Authorization 头传递，不放在 URL 中。Web 浏览器直接连接媒体 WebSocket 会被拒绝，管理界面通过 Koishi 已认证 RPC 操作。

一次只允许一个 Koishi 媒体连接。网络请求超时不自动重试状态变更命令，避免重复拨号。重连会形成新的本地会话标识，需要重新取得控制权。

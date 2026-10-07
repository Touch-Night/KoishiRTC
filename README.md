# Koishi RTC Bridge

让 Koishi 插件拥有实时通话能力：管理通话、收发连续音频、接收摄像头和屏幕画面，以及向两种视频渠道发送自定义内容。

这是独立的通话基础设施，不绑定任何大模型或语音服务。上层插件可以接 Realtime API、STT + TTS、录音或其他音频应用。

- **统一服务**：`ctx.rtc`，独占控制、生命周期清理、取消播放、有限音频队列。
- **QQ**：NapCat 原生通话控制与 AVSDK Host，独立虚拟音频路由。
- **独立视频渠道**：摄像头与屏幕共享可同时发送不同画面；消费插件通过 JPEG 帧接口提供内容，也可明确选择设备或窗口。
- **Discord**：服务器语音频道，按用户区分接收音轨，支持加入、退出、静音和连续音频。
- **Telegram**：普通用户账号的私聊与群通话，独立登录、连续音频和视频帧接口。
- **微信、飞书、腾讯会议**：桌面通话后端，使用 Linux AT-SPI、Windows UIA 或 macOS AX 控制客户端，配合独立虚拟音频收发。首次使用需要校准当前客户端的控件和账号、设备信息。
- **LiveKit**：直接加入音视频房间，按成员收音，摄像头和屏幕共享两路独立收发。
- **KOOK**：使用官方接口向语音频道持续推流；不声明官方接口未提供的收音能力。
- **控制台**：来电接听、拒接、挂断、群语音点选、音量表、测试音、设备选择与诊断。
- **明确的回执**：提交操作、平台接通、本地播放排空和网络发送分别报告。

Linux ARM64 的 QQ 群通话和主动私聊音视频已进行真实账号测试，包含双路视频收发。Windows/macOS 的 QQ 视频已补齐实现，待实机验证；LiveKit 已通过本机真实服务端媒体测试。Telegram、KOOK 和 Discord 尚未完成平台账号在线验收。详见[平台能力说明](docs/platforms.md)。

## 快速开始

要求 Node.js 22.19 或更新版本、Koishi 4.18.11。控制台操作需要 `console`、`auth` 插件以及权限等级 4 的账号。

源码安装：

```sh
npm install
npm run build
npm test
npm pack
```

在你的 Koishi 项目中安装生成的包：

```sh
npm install /绝对路径/koishi-plugin-rtc-bridge-0.2.0.tgz
```

然后在 Koishi 插件配置中添加 `rtc-bridge`。默认没有任何账号配置，不会自动拨打、接听或录音。

**使用 QQ**：先按照 [QQ 安装说明](bridge/qq/README.md)准备完整客户端、NapCat 控制插件与 AVSDK Host，然后配置[桌面音频桥](docs/desktop-bridge.md)。仅安装 OneBot 消息适配器不能获得实时通话音频。

**使用 Discord**：按照 [Discord 配置说明](docs/discord.md)填写 Bot Token、机器人 ID 和允许加入的服务器。控制台会列出有权限的普通语音频道，无需虚拟声卡。

**其他后端**：[Telegram 安装与登录](docs/telegram-setup.md) · [LiveKit 房间](docs/livekit.md) · [KOOK 语音推流](docs/kook.md)。不同后端独立配置，空白名单不会自动加入任何通话。

**使用微信、飞书、腾讯会议**：按照[桌面通话安装与校准](docs/desktop-calls.md)配置独立桥接进程，再在 Koishi 添加对应的桌面后端。代码路径已实现，尚未完成这些客户端的真实通话验收；不同版本的界面需要分别校准。

打开 Koishi 控制台的 **实时通话** 页面。桥接会自动检查已配置的音频设备；“连接检查”用于查看诊断和更改空闲时的设备路由，不是启用声音的前置步骤。测试音会显示本机播放回执或具体错误，是否送达仍以对方实际听到为准。

## WebUI

启用 `console` 和 `auth` 插件后，以权限等级 4 的账号登录 Koishi 控制台，从侧栏进入 **实时通话**，或在控制台地址后加上 `/rtc`。地址取决于 Koishi 的监听端口和 `console.uiPath`：例如端口为 `5140`、`uiPath` 为 `/console` 时，页面是 [http://127.0.0.1:5140/console/rtc](http://127.0.0.1:5140/console/rtc)；`uiPath` 为空时则是 `/rtc`。

视频或屏幕共享邀请可在拨号前选择画面来源，接通后自动开始发送；默认可选的是明确标注的动态测试画面。真实摄像头、窗口和桌面需要自行选择。已有语音通话可从“视频与屏幕共享”打开画面；QQ 私聊转屏幕共享会显示转换进度，原生通话切换期间音频可能短暂停顿。

本项目还提供独立开发控制台。在源码目录完成安装和构建后运行：

```sh
npm run dev:console
```

默认登录页：[http://127.0.0.1:6129/console/login](http://127.0.0.1:6129/console/login)；实时通话页：[http://127.0.0.1:6129/console/rtc](http://127.0.0.1:6129/console/rtc)。首次启动生成的账号、密码和端口配置保存在本机 `runtime/console/config.json`，请从该文件读取登录凭据。

以下截图由实际 Vue 控制台组件配合演示数据生成，用于展示界面，不代表真实通话验收结果。

**通话概览与音频控制**

![实时通话 WebUI 概览（演示数据）](https://raw.githubusercontent.com/Touch-Night/KoishiRTC/main/docs/images/webui-overview.png)

**摄像头与屏幕共享**

![实时通话 WebUI 视频预览与发送来源（演示数据）](https://raw.githubusercontent.com/Touch-Night/KoishiRTC/main/docs/images/webui-video.png)

**移动端布局**

<img src="https://raw.githubusercontent.com/Touch-Night/KoishiRTC/main/docs/images/webui-mobile.png" alt="实时通话 WebUI 移动端布局（演示数据）" width="390">

## 给插件开发者

```ts
import type {} from 'koishi-plugin-rtc-bridge'
export const inject = ['rtc']

export function apply(ctx) {
  const control = ctx.rtc.controller(ctx, 'my-voice-assistant')
  // 由你自己的指令或来电策略明确触发：
  // control.claim(callId)
  // await control.accept(callId)
  // for await (const frame of control.audio(callId, { signal })) { ... }
  // await control.writeAudio(callId, pcmFrame)
  // await control.clearAudio(callId) // 打断尚未发送/播放的回复
}
```

完整说明：[服务 API](docs/api.md) · [双向音频设备](docs/audio-setup.md) · [验收清单](docs/testing.md)。

采用 GPL-3.0-only；QQ 桥接参考 `ClaudiaGardner/maibot-qq-voice-call`，保留其署名。QQ 客户端与虚拟音频驱动需要另外安装，包内不包含这些专有程序。

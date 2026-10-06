# 平台能力与验证范围

本插件把平台控制和连续媒体分开。标准 Koishi/OneBot 的音频消息接口不是实时通话接口；不能仅凭适配器名称宣称支持打电话。

| 后端 | 私聊电话 | 群语音 | 音频 | 当前验证 |
| --- | --- | --- | --- | --- |
| QQ Linux，固定版本完整客户端 + NapCat | 拨打、来电、接听、拒接、挂断 | 检测活跃房间、加入、退出 | 独立 PulseAudio 双向混音 | ARM64 已真实验证私聊接听/主动拨号、群通话加入/创建/邀请、连续音频及本端挂断状态确认 |
| QQ Windows x64，固定版本完整客户端 + NapCat | 同一协议，Windows 原生命令画像 | 同上 | 两条虚拟设备 + PortAudio；原生设备选择回执 | 官方二进制静态核验及离线测试；待 Windows 实测 |
| QQ macOS Intel / Apple Silicon，固定版本完整客户端 + NapCat | 同一协议，macOS 原生命令画像 | 同上 | BlackHole + PortAudio；原生设备选择回执 | 官方二进制静态核验及离线测试；暂无 Mac 实测机 |
| Discord Bot | 官方 Bot 后端不提供私聊语音来电/拨号 | 普通服务器语音频道；非 Stage | SDK 双向音频，接收按用户分轨 | 离线测试与实际 Opus 编解码通过；用户决定暂缓频道验收 |

QQ 的具体库指纹、命令来源和版本限制见 [QQ 兼容性文档](qq-compatibility.md)、[Windows 说明](qq-windows.md)、[macOS 说明](qq-macos.md)。不对未知 QQ 版本自动套用命令编号。GUI 菜单出现了“语音”并不等于桥接已能获取连续音频。

## 视频能力与平台边界

音频后端、虚拟摄像头生产程序与 QQ 原生视频桥接分别验证；具备其中一项不代表另外两项已经可用。

| QQ 原生平台 | 当前视频范围 | 验证状态 |
| --- | --- | --- |
| Linux ARM64，3.2.34-53644 | 群摄像头接收与双路独立发送；普通私聊摄像头收发；私聊共享会话的摄像头和屏幕同时收发 | 上述项目已真实验证。发送测试使用消费插件提供的生成画面；未据此宣称所有物理设备均已验证 |
| Linux x64，同版本固定指纹 | 启用经过该二进制独立静态核验的视频路径 | 静态协议与离线测试；尚无 x64 实机视频验收 |
| Windows x64，9.9.36-53644 | 已实现视频收发、外部帧与明确选择的设备/窗口/显示器来源 | 精确版本协议审计及离线回归通过；未实机验收 |
| macOS Intel / Apple Silicon，7.0.2-53644 | 已实现视频收发、窗口 ID 映射、采集权限检查、外部帧与明确选择的来源 | 两种切片静态协议审计及离线回归通过；未实机验收 |

2026-10-06 对已有本地 Windows/macOS 官方 SDK 的有界静态检查确认：30/31、33–36、44–49、54 都不是空实现；20031 均携带 `[uid, sourceType, width, height]`，20053 均是摄像头设备丢失的空通知，不能当作首帧。命令 54 没有同步消息回执，命令 32 在 Windows 与 macOS 两种切片均为空实现，不能作为通用原始帧注入接口。

这些编号相同不表示可直接复用全部参数与成功判定。macOS 的命令 44 消费 `is_full_screen` 与 `window_or_display_id`，未消费 Linux 的第三个 computerVoice 参数。实现已区分 macOS 的 NSView 指针与 CGWindowID；窗口/显示器由明确选择的 Electron 来源采集并中继，不把来源名称猜作原生 ID。macOS 的 47 同样有排队回执与稍后 DeviceOpen 回执；两平台 49 在没有摄像头 core 时均可能返回 -1，不能把任意 -1 当成功。平台实现和安装步骤见[桌面视频说明](qq-desktop-video.md)。

当前只对代码中匹配的固定构建启用路径，仍需本机满足权限与依赖；Windows/macOS 未实测，不能据离线测试宣称远端画面已经正确。普通私聊 `media` 为 `audio`、`video` 或 `screen`；发起邀请不会自动选择视频来源，详见[私聊视频与屏幕共享协议](qq-private-screen-research.md)。

## 其他主流平台

平台无关接口允许外部插件注册自己的后端，尚未实现的后端不能在本插件中选中使用。

- **Telegram**：已实现基于 Telethon、PyTgCalls/NTgCalls 的普通账号后端，包含本地登录工具、私聊/群通话、音视频接口和退出清理。普通 Bot Token 不能使用。Linux ARM64 原生库与编解码检查通过，没有 Telegram 账号在线验收；安装平台须有相应原生依赖。见[安装说明](telegram-setup.md)。
- **KOOK**：已实现官方 voice API 和 Opus/RTP 推流、保持连接、清空/静音及退出。真实本地 UDP 编解码测试通过；官方公开接口不提供接收音频，能力表明确关闭收音和视频。见[配置说明](kook.md)。
- **LiveKit**：已实现房间双向音频和独立摄像头/屏幕视频。两个客户端与官方本地服务端的真实传输验证通过；尚未验证用户的云端服务器和网络环境。见[配置说明](livekit.md)。
- **微信、飞书、腾讯会议**：已实现桌面客户端控制与虚拟音频后端，覆盖 Linux AT-SPI、Windows UIA、macOS AX；提供三个应用各三个系统的校准配置。微信支持私聊拨号/来电处理，飞书和腾讯会议支持明确会议目标的加入/离开。首次需要按实际版本确认账号、目标、状态控件和音频路由。已完成离线及桥接协议链路回归，尚未做这些客户端的真实通话验证，不能把预置配置当作开箱即用保证。见[桌面通话说明](desktop-calls.md)。
- **Matrix / SIP**：尚无原生适配器。LiveKit 媒体房间不能直接冒充 Matrix 的入会信令或 SIP 注册/呼叫；这两种平台需要各自的信令后端或已配置的网关。
- **其他即时通讯平台**：需核实其公开或本地客户端通话接口。已有虚拟声卡只能解决音频路由，不能替代来电、接听、挂断等真实平台控制。

相关一手资料：[Koishi 平台适配器](https://koishi.chat/zh-CN/guide/adapter/bot)、[Discord Voice SDK](https://discord.js.org/docs/packages/voice/stable)、[Telegram requestCall](https://core.telegram.org/method/phone.requestCall)、[Telegram joinGroupCall](https://core.telegram.org/method/phone.joinGroupCall)、[NTgCalls](https://github.com/pytgcalls/ntgcalls)、[KOOK voice API](https://developer.kookapp.cn/doc/http/voice)。

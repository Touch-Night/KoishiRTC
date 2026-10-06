# Windows QQ 原生通话测试包

这套脚本已针对腾讯官方 **Windows QQ 9.9.36-53644 x64** 做静态核对，并接入共享 QQ 通话控制器。可以准备独立程序副本、诊断依赖、启动 AVSDK Host 与 NapCat、查询设备、选择原生音频路由，以及通过本地接口拨号、接听、拒接、挂断和加入已有群语音。

**Windows 运行验收尚未完成。** 本轮在 Linux 上没有运行 QQ.exe、Windows DLL、安装程序，没有登录或拨打电话。静态 ABI 与离线测试通过不等于 Windows 上已成功接通；用户测试时应先完成加载、身份、设备确认，再进行明确选定的通话。

## 已核对的官方组件

| 项目 | 结果 |
| --- | --- |
| 安装包 | `QQ_9.9.36_260924_x64_01.exe`，330446512 字节 |
| 安装包 SHA256 | `63255c70c7ff523e7eed7d52d9708ed7a77ea346ece6474c65dded406edb3155` |
| 原生插件 | `versions/9.9.36-53644/resources/app/avsdk/AVSDKPlugin.dll` |
| 插件 SHA256 | `199a6e8d2849908ce33ea21085be702b69ee6938a67191b3e0dbe753caab93ac` |
| 加载方式 | QQ 自带 Electron/QQNT.dll，PPAPI MIME `application/x-ppapi-avSDK` |
| 必需开关 | `register-pepper-plugins`、Windows GUI 使用的 `allow-command-line-plugins` |
| 私聊控制 | cmd4 拨号、5 接听、9 拒接、10 挂断 |
| 群语音控制 | cmd4，scene3、无邀请人、original3；cmd8 退出 |
| 成员与结束事件 | 20008/20009 进出、20010 房间快照、20011 销毁、20018/20019 对端拒绝/取消、20022 关闭 |
| 原生声卡 | cmd103 枚举、102 选择、20061 实际设备状态 |

命令号、字段和对应 PE/V8 字节码位置保存在 [native-evidence.json](../bridge/qq/windows/native-evidence.json)。数据来自同一个完整官方安装包，不混用 Linux 动态库或不同 QQ 版本。其他 QQ 版本、x86、Windows ARM64 原生构建会拒绝启用此 profile。`cmd102` 返回 `[1, ""]` 只是命令提交，必须再收到 20061 确认选中的设备才会设置 `routeReady`。

参考来源：[腾讯 QQ 官方站](https://im.qq.com/index/)、[官方版本配置](https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json)、[NapCat Shell 启动文档](https://napneko.github.io/guide/boot/Shell)、[官方 Windows 10 普通用户启动器](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-shell-loader/launcher-win10-user.bat)、[原通话项目](https://github.com/ClaudiaGardner/maibot-qq-voice-call)。这里使用 NapCat 官方 WinBoot 的包入口替换机制，不修改源 QQ 的 package.json，不安装全局注入或系统服务。

## 准备 Windows 10/11 x64 测试机

需要 Node.js **22.19+ x64**、完整的指定 QQ x64 程序文件、官方 NapCat Shell x64 发布包（含 `napcat.mjs`、`NapCatWinBootMain.exe`、`NapCatWinBootHook.dll`）、Microsoft VC++ 2015–2022 x64 运行库，以及两个不同的虚拟音频总线。Python/PortAudio 连续音频后端的安装见 [audio-setup.md](audio-setup.md)。每个虚拟总线应各有播放端与录音端，不能用一个回环总线同时承载收发。

建议在单独 Windows 用户会话里测试。脚本隔离程序副本与 Electron userData，但尚未证明 QQ/NapCat 所有账号、系统注册表及原生数据目录都服从该参数；因此不能承诺它与同一 Windows 用户下已登录的正式 QQ 账号完全隔离。脚本不扫描、结束或重启已有 QQ 进程，也不复制已有聊天资料。

**同一测试 QQ 号一次只运行一组 Host + NapCat。** 启动前自行退出该账号的原桌面 QQ、其他 NapCat 和其他机器上的测试实例；本组 Host 与 NapCat 是配套进程，需要同时运行。新目录或新 Windows 用户不会隔离平台账号的在线状态，双开可能互踢或干扰通话信令。测试结束并确认这组 QQ 子进程停止后，再恢复原桌面 QQ。

将整个 KoishiRTC 项目复制到例如 `C:\KoishiRTC`。桥接管理脚本只用 Node 内置库，无需先安装整个 Koishi 插件。音频 daemon 和 Koishi 服务的依赖按主项目说明安装。

官方历史包需要腾讯官网的临时下载签名。可运行下面的下载脚本；它只下载并核验固定 SHA256，不安装或执行文件，也不会打印临时下载令牌：

```powershell
cd C:\KoishiRTC
node .\bridge\qq\windows\fetch-qq.mjs C:\RTCDownloads\QQ_9.9.36_260924_x64_01.exe
```

先创建 `C:\RTCDownloads`。使用 7-Zip 打开该安装包并解压 `Files` 目录，得到 `QQ.exe` 和 `versions\config.json`；不要运行安装包。将 NapCat Shell 发布包解压到另一个新目录。保留 QQ 当前版本整个目录，包括 AVSDK 同目录的 `liteav.dll` 等依赖；某些精简整合包删除了 AVSDK，不能使用。

先检查计划，再创建新的目标目录；目标必须尚不存在：

```powershell
.\bridge\qq\windows\rtc-qq.ps1 install -QQSource C:\RTCDownloads\QQ\Files -NapCatSource C:\RTCDownloads\NapCatShell -InstallDir C:\RTCQQ -Check
.\bridge\qq\windows\rtc-qq.ps1 install -QQSource C:\RTCDownloads\QQ\Files -NapCatSource C:\RTCDownloads\NapCatShell -InstallDir C:\RTCQQ
.\bridge\qq\windows\rtc-qq.ps1 doctor -InstallDir C:\RTCQQ
```

安装只写新目标；不会启动进程或更改源目录。若 NapCat 发行版限制官方插件白名单，会在新副本扫描流程增加明确的本地插件入口，保留原始 bundle 与 SHA256，官方白名单保持原样；worker 直接导入 bundle 时也会初始化此入口。未知扫描结构会拒绝准备。控制 token 放在 `C:\RTCQQ\runtime\control.token`，PowerShell 包装器为 runtime 设置当前用户与 SYSTEM 的 NTFS ACL。不要把 token 放进问题反馈。若脚本因执行策略被拒绝，可在已经检查脚本内容后，使用独立进程 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...` 执行；不需要修改机器的全局执行策略。

`doctor` 检查版本、PE 架构、AVSDK 哈希、入口文件、启动器、签名状态及 VC++ DLL 是否存在，不加载 QQ 或打开音频设备。某些组件本身未单独签名；官方包固定哈希与运行时加载检查仍是不同证据。PowerShell 脚本当前仅在 Linux 上做了人工语法检查，尚未由 Windows PowerShell 执行验证。

## 启动并选择原生音频设备

在两个终端分别运行；程序不会自动重启、接听、拨号或加入群：

```powershell
C:\KoishiRTC\bridge\qq\windows\rtc-qq.ps1 run-av-host -InstallDir C:\RTCQQ
```

```powershell
C:\KoishiRTC\bridge\qq\windows\rtc-qq.ps1 run-napcat -InstallDir C:\RTCQQ
```

使用 NapCat 提示登录测试账号，然后从第三个终端检查：

```powershell
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action host-status
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action status
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action devices
```

核对 Host 的 `nativeProfile.id`、`ready`/`pluginFound`、桥接身份 `selfId`/`selfUid`。设备 ID 来自 **AVSDK 自己的枚举**，不是 Windows 面板顺序，也不是 PortAudio 的 ID。QQ GUI 选择声卡不会自动传递到独立 AV Host。

两条总线的连接方向：

| 用途 | AVSDK | PCM bridge / Python sounddevice |
| --- | --- | --- |
| 收到对方声音 RX | output → RX 总线的播放端 | input ← RX 总线的录音端 |
| 发给对方声音 TX | input ← TX 总线的录音端 | output → TX 总线的播放端 |

将枚举中的实际虚拟设备 ID 和完整名称写入 UTF-8 `C:\RTCQQ\runtime\route.json`，例如以下占位内容必须替换：

```json
{
  "input": { "id": 12, "name": "实际 TX 录音端名称" },
  "output": { "id": 34, "name": "实际 RX 播放端名称" }
}
```

```powershell
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action route -BodyFile C:\RTCQQ\runtime\route.json
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action capabilities
```

只有再次枚举确认 ID、名称及选中状态一致，`routeReady` 才为真。默认设备 ID 0、同名收发端点、身份不匹配都会拒绝。设备是否确为虚拟设备由操作者核对，代码不会仅凭名称声称已经验证其硬件类型。Host 重启后必须重新选择，不盲用上次启动的动态设备 ID。

通话前会再检查路由，Host 持续轮询并处理设备变更；发现路由丢失或切换后会关闭原生 Host，不自动选择真实麦克风。**仍需 Windows 验收设备移除行为**：事件通知和关闭进程存在时延，静态检查无法证明 AVSDK 在通知之前绝不短暂使用默认设备。首次测试可在专用 Windows 用户/机器上禁用真实录音设备，避免把尚未验证的 native fallback 当作已保证的特性。

## 显式控制和回执

只使用稳定 `requestId`，不要在超时后换一个 ID 重试。`submitted`/命令 ACK 不是接通或挂断完成；以 `current` 和 `events` 的原生生命周期变化为准。每次发起控制前核对 `status` 的登录账号。

```powershell
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action current
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action events
```

向选定测试联系人拨号的 JSON 文件：

```json
{ "requestId": "win-test-dial-001", "peerUin": "替换为对方QQ号" }
```

```powershell
.\bridge\qq\windows\rtc-qq.ps1 control -InstallDir C:\RTCQQ -Action dial -BodyFile .\dial.json
```

接听、拒接、挂断使用当前真实 `callId`，JSON 为 `{"requestId":"win-test-accept-001","callId":"替换为当前callId"}`，将 `-Action` 分别设为 `accept`、`reject` 或 `hangup`。群语音先用 `-Action groups` 查询，加入 JSON 为 `{"requestId":"win-test-join-001","groupId":"替换为群号"}`，使用 `group-join`；退出用 callId JSON 和 `group-leave`。

加入已有群语音依赖最近实际群活动通知与成员数检查。QQ 原生接口没有已验证的“只能加入、绝不创建”的原子参数，因此群在检查后恰好结束仍存在竞态。未知/过期活动应拒绝加入。不要把群成员列表或谁在发言的 UI 状态当作音轨身份：当前虚拟输出得到的是混音，多人同时讲话没有可靠逐人 PCM，成员进出事件只能作为独立的参与者信息。需要逐人转写/打断策略时，应先取得真正的分轨接口或保留 speaker=unknown。

## 验收与退出

Windows 首轮按以下顺序记录结果：

1. `doctor` 哈希/架构通过，启动后 PPAPI `postMessage` 可用，身份是测试账号。
2. 只枚举、选择两个虚拟设备，确认 routeReady，重启后不自动恢复旧 ID。
3. 向明确选定的测试对象分别拨出/接听/拒接/挂断；观察 `submitted`、connected、ended 的区别。
4. 双向声音连续工作，RX/TX 不互相回流；确认静音、清空队列、远端挂断后的资源释放。
5. 已存在群语音的加入/退出、成员进出及多人同时讲话；确认混音不会被错误标成某一个人的音轨。
6. 最后在受控环境移除虚拟设备，确认 Host 停止且未使用真实麦克风；这一步通过前不能宣称完成断线隔离验收。

启动器退出码只能说明 WinBoot 进程退出，有些版本会分离 QQ 子进程；不能以它判定 QQ 已成功启动或已完全停止。结束测试先显式挂断/退出群，再关闭对应测试 QQ/Host 窗口或在任务管理器按 **新目录路径**定位进程。脚本不结束路径不明的 QQ。

禁用本测试副本的插件与生成入口：

```powershell
.\bridge\qq\windows\rtc-qq.ps1 disable -InstallDir C:\RTCQQ
```

该操作不停止运行中的进程，也不删除账号资料、token、日志或程序文件。被人工修改过的入口会保留并报告；未修改的生成入口改名为 `.disabled`。确认相关测试进程退出后，可自行归档或删除整个新目录，源 QQ/NapCat 文件没有变更。

离线自测（使用假 PE 文件、假 native 回调，不录音、不播放）：

```powershell
node --test .\bridge\qq\windows\*.test.mjs
```

## 视频收发（实现已开放，等待 Windows 实机验收）

匹配 QQ 9.9.36-53644 x64 的精确 DLL 后，私聊视频/屏幕共享邀请、群内视频订阅、摄像头和屏幕两路并行发送已接入。新增原生协议证据见 [desktop-video-evidence.json](../bridge/qq/desktop-video-evidence.json)。实现通过离线协议与集成回归；当前没有 Windows QQ 实际通话验收结果，首次使用应按控制台状态逐步确认。

控制台枚举摄像头、窗口和显示器，只有明确选择后才启动采集。窗口/显示器使用 Electron 的精确 source ID，经独立、仅允许显示捕获的 session 转入自有窗口，再将该窗口的 HWND 传给 QQ。来源关闭后停止此渠道，不自动选择桌面。接收则只读取 QQ 对当前实际参与者解码的专用窗口，不读取本地桌面；两条接收来源可独立订阅。

`external-frames` 可以给摄像头和屏幕分别写 JPEG，来源可以是渲染器、文件解码器、其他视频服务等。屏幕渠道无需真实共享桌面；使用窗口中继即可。摄像头渠道需要预装 OBS Virtual Camera 或 Unity Capture；本插件不会替用户安装驱动。先确保 Windows 隐私设置允许桌面应用访问摄像头。

例如使用 OBS，安装后关闭 OBS 的虚拟摄像头生产者，安装 Python 依赖：

```powershell
py -3 -m venv "$InstallDir\video-venv"
& "$InstallDir\video-venv\Scripts\python.exe" -m pip install -r bridge\video\requirements.txt
node bridge\qq\scripts\configure-video.mjs `
  --bridge-dir "$InstallDir" `
  --python "$InstallDir\video-venv\Scripts\python.exe" `
  --backend obs --device "OBS Virtual Camera" `
  --qq-device-id "此机实际枚举的相机ID"
```

`--qq-device-id` 取自控制台该相机的 `camera:...` 来源 ID，去掉 `camera:` 前缀。配置工具检查依赖后写入 `runtime/video.json`，不打开摄像头；设备打开时重新匹配 QQ 枚举、后端和实际设备。现有文件默认拒绝覆盖，明确更新加 `--replace`，仅检查加 `--check`。使用 Unity Capture 时改 `--backend unitycapture` 并填入其确切设备名称和 QQ ID。官方安装依据：[pyvirtualcam Windows OBS / Unity Capture](https://github.com/letmaik/pyvirtualcam#supported-virtual-cameras)。

两条渠道的启停、帧序列和回执互不混用；停止屏幕不停止摄像头。相机可显式设置 `framing: 'portrait-safe'`；默认完整画面，不强制旋转输入。原生 ACK 与虚拟设备写入只证明本地处理，不伪造远端画面送达。挂断在原生 GetChattingRoomId 返回空闲后结束，单纯提交 Close 不表示已结束。

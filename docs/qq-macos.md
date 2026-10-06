# macOS QQ 原生实时语音后端

Mac 后端使用 **QQ 自带的 Electron + AVSDK、NapCat 原生会话服务和两条 BlackHole 音频线路**。私聊拨号/接听/拒接/挂断、群语音加入/离开与参与者事件使用共享控制桥，Koishi 插件继续通过 `ctx.rtc` 调用，不需要绑定 QQ 页面上的按钮。

**当前验证边界：完成官方双架构安装包、GUI 字节码和原生命令/回调 ABI 的静态核对；没有 Mac 实机，尚未验收签名启动、NapCat 登录、TCC 权限、真实私聊/群语音和双向声音。** 安装脚本、设备路由状态机不是成功通话记录。运行时还必须通过库指纹、原生服务、账号身份和音频选路检查。

## 核对的官方包

2026-10-05 从 [QQ 官网](https://im.qq.com/macqq/) 的 [下载配置](https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json) 获取 `QQ_7.0.2_260924_01.dmg`。下载使用官网自己的 URL 签名接口，未执行包中任何代码。

| 项目 | 静态结果 |
| --- | --- |
| 应用版本/构建 | `7.0.2-53644`，DMG 标识 `QQ-v7.0.2-53644-universal-mas-p` |
| 可执行文件/AVSDK | Universal Mach-O，均包含 Intel x64 与 Apple Silicon arm64 |
| Electron | 包内 `QQNT.framework` 的 `CFBundleVersion` 为 `40.0.0` |
| AVSDK | `QQ.app/Contents/Resources/app/avsdk/libAVSDKPlugin.dylib` |
| AVSDK SHA-256 | `8dcddc9ade6120ba1fecb7f8961d401dded8c4881ce3e12b5a023465089c64c6` |
| DMG SHA-256 | `d270b78f0b210532637076532a883dc8659851b6daa92451983985ab9f3216f0` |
| 原生入口 | `PPP_GetInterface`、`PPP_InitializeModule`、`PPP_ShutdownModule` |
| 捆绑依赖 | `TXFFmpeg.framework`、`TXSoundTouch.framework`，原生库 `rpath=@loader_path` |

完整命令表地址、回调字段、分架构哈希和 GUI 比对记录见 [native-evidence.json](../bridge/qq/macos/native-evidence.json)。QQ 的 `package.json` 写有 `eleArch=x64`，但真实 Mach-O 包含两个架构；不能只用该字段判断 Apple Silicon 支持。

私聊 StartCall=4，Accept=5，Reject=9，Close=10；群退出 Quit=8；房间快照 GetRoomInfo=13。Mac 的 GUI 私聊参数生成、场景选择、退出与 JSON 转换与已审计 Linux 构建一致，两个 Mac 原生切片的命令表及已使用的回调结构分别核对。专有二进制不随仓库分发。

## 在 Mac 上准备

建议使用**专门的 macOS 用户和测试 QQ 账号**。应用副本保留 `com.tencent.qq` 标识，因此仍可能访问该 macOS 用户原有的 QQ 容器；仅复制 `.app` 或指定 `--user-data-dir` 不能保证 QQ 账号数据库隔离。

1. 从 QQ 官网安装上述完整版本或提供该版本 `.app`。不要把新 AVSDK 单独放进旧 QQ。
2. 从 [NapNeko/NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载完整 `NapCat.Shell.zip`，解压到新目录。脚本拒绝复制含有现成 `config`、`logs` 或符号链接的 NapCat 运行目录。当前本地扩展 hook 核对 NapCat 4.18.13 的 worker 扫描结构；其他结构会在复制前停止，不能任意套用。
3. 安装 Python 3.10+、Node.js，以及两种独立设备 `BlackHole 2ch` 和 `BlackHole 16ch`。按 [BlackHole 官方安装说明](https://github.com/ExistentialAudio/BlackHole) 安装；已有 Homebrew 时可执行 `brew install blackhole-2ch blackhole-16ch`。音频驱动安装不由本脚本隐式执行。
4. 在“音频 MIDI 设置”中将两条线路设为 48 kHz。端到端配置使用 PCM16、48 kHz、单声道、20 ms 帧；QQ/设备侧可能有内部混音或重采样。

NapCat 的 [官方 Mac 安装器源码](https://github.com/NapNeko/NapCat-Mac-Installer) 已展示容器内加载 `napcat.mjs` 和 QQ 入口替换方式。本项目把这些修改应用于自行复制的应用，不调用那个安装器修改 `/Applications/QQ.app`。

## 文件诊断与可逆安装

在仓库根目录执行：

```sh
python3 bridge/qq/macos/probe.py --qq-app /Applications/QQ.app

RTC_INSTALL="$HOME/Library/Containers/com.tencent.qq/Data/Documents/KoishiRTCQQ"
python3 bridge/qq/macos/install.py install \
  --qq-app /Applications/QQ.app \
  --napcat-dir "$HOME/Downloads/NapCat.Shell" \
  --install-dir "$RTC_INSTALL" --adhoc-sign --check

python3 bridge/qq/macos/install.py install \
  --qq-app /Applications/QQ.app \
  --napcat-dir "$HOME/Downloads/NapCat.Shell" \
  --install-dir "$RTC_INSTALL" --adhoc-sign
```

`--check` 只读文件，Linux 上也可检查已解压的 `.app`。安装使用 `ditto` 保留 bundle 符号链接和资源，复制完整 QQ 与 NapCat，再安装共享桥插件。安装写入本副本 `napcat/config/plugins.json` 的 `napcat-plugin-koishi-rtc-qq: true`，默认只观察、不转发 AVSDK。默认端口为回环 `6110/6111`，可用 `--port`、`--av-port` 改为两个不同端口。安装不会启动、重启或登录 QQ。

`--adhoc-sign` 使用 macOS `codesign` 重签**副本的顶层 bundle**，保留现有 entitlements/flags；不递归重签原生库，再用 `--verify --deep --strict` 校验。安装还检查签名前后 AVSDK 文件哈希一致，避免代码签名改动破坏精确原生库指纹。入口修改会改变副本签名，省略此选项时不能假设副本可以启动。未关闭 Gatekeeper/SIP、未清除系统隔离属性。Mac 的 App 管理、沙箱和 TCC 是否接受此副本仍需实机确认；若系统拒绝，保留准确错误和 `codesign --verify --deep --strict` 的结果，不能把静态探测通过当作已启动。

NapCat 4.18.13 的普通目录扫描会拒绝非官方白名单插件，仅设置 `plugins.json` 不足以加载本桥。安装器在独立副本加入显式本地 bootstrap，只加载 `napcat-plugin-koishi-rtc-qq`，保留官方 whitelist 和正常插件启用开关。QQ 入口只在 NapCat 模式加载 `napcat/koishi-rtc-loader.cjs`；`napcat.mjs` 的实际 utility worker 也自行导入 bootstrap，因为 `utilityProcess.fork` 不会继承父进程的 JavaScript 全局回调。

`napcat/koishi-rtc-local-bootstrap.json` 记录 worker、父 loader、辅助脚本的哈希和两份逐字节备份。`run.py napcat` 会在启动前校验这些文件；文件被改动、只注入了父进程、或 hook 已恢复时拒绝启动。安装器离线测试覆盖独立 Node worker 的自注册、重复安装保护、恢复与改动检测；这些测试没有执行 QQ，也不能替代 Mac 实机验收。

安装目录放在 QQ 沙箱容器的 `Data/Documents` 内，供原有沙箱权限读取。`runtime/control.token` 为 0600 文件，安装只打印其路径。账号容器、系统驱动和原 QQ 均不由卸载命令删除。

## 双向音频检查

| 声音方向 | QQ 原生 AV Host | Python/PortAudio |
| --- | --- | --- |
| 机器人 → QQ | 麦克风 `BlackHole 2ch` | 向 `BlackHole 2ch` 的 output 写 PCM |
| QQ → 机器人 | 扬声器 `BlackHole 16ch` | 从 `BlackHole 16ch` 的 input 读 PCM |

它们是两个不同设备。不要把同一 BlackHole 同时用于收音和发音，也不要用系统默认麦克风代替显式线路。

```sh
python3 -m venv .venv-rtc-audio
.venv-rtc-audio/bin/python -m pip install -r bridge/audio/requirements.txt
.venv-rtc-audio/bin/python bridge/qq/macos/audio-check.py
```

检查脚本只枚举设备并验证格式，不打开录音或播放流。输出 `audio` 对象可用于 RTC daemon 配置，包括实际解释器绝对路径和完整 `pa:` 设备标识。详见 [音频后端配置](audio-setup.md)。缺少、重名或格式不兼容的设备会失败。

独立 AV Host 不依赖 QQ GUI 的历史设备偏好。Mac 路由器调用原生命令 **103** 枚举、**102** 选择输入/输出 ID，并等待 **20061** 回调证实两个选中设备。命令 102 固定回复 `[1, ""]`，这不是选路成功证据。原生设备切换、丢失或状态过期后路由器关闭 Host，需修复后显式重启；设备变化通知可能有系统延迟，尚无实机测量。

macOS 首次访问音频时可能要求 QQ/Python/终端的麦克风权限。设备枚举成功不能替代 TCC 授权。此后端未开启系统混音录制或屏幕声音采集。

## 显式启动与检查

分别在两个终端运行，并保持前台：

```sh
RTC_INSTALL="$HOME/Library/Containers/com.tencent.qq/Data/Documents/KoishiRTCQQ"
python3 "$RTC_INSTALL/bridge/qq/macos/run.py" --install-dir "$RTC_INSTALL" host
```

```sh
RTC_INSTALL="$HOME/Library/Containers/com.tencent.qq/Data/Documents/KoishiRTCQQ"
python3 "$RTC_INSTALL/bridge/qq/macos/run.py" --install-dir "$RTC_INSTALL" napcat --media
```

第二个进程由用户按 NapCat 提示完成测试账号登录。没有 `--media` 时桥为观察模式。若有需要，可显式交换两个设备：两个启动命令均传入 `--qq-microphone 'BlackHole 16ch' --qq-speaker 'BlackHole 2ch'`，并用相同参数重新运行 `audio-check.py`。

```sh
python3 "$RTC_INSTALL/bridge/qq/macos/run.py" --install-dir "$RTC_INSTALL" status
```

检查实际 `selfId`、Host 原生插件、精确 `nativeProfile`、`audioRouting.ready` 和桥 capabilities。缺少任何一个条件时，调用失败应显示具体原因。Host 的进程在线、命令提交回执和 `connected` 回调均不能证明对方听到了声音。

真实验收至少包含：私聊主动拨号与被叫接听、拒接与双方挂断、已有群语音加入/离开、参与者房间快照、两端轮流发声、设备拔除后停止、重启后的身份与路由重核。群语音媒体是 QQ 提供的混合声音，参与者名单不等于当前说话人。

群“加入”通过原生 StartCall 的群场景与空邀请列表完成，必须有新鲜活动/房间证据。该接口没有原子的 `onlyJoinExistingRoom` 标志；检查后群通话恰好结束时仍存在创建新房间的竞争窗口，不能宣称绝对只加入不创建。

## 仅撤销 NapCat 本地扩展

先退出此安装的 QQ、Host 与 NapCat worker。以下命令保留应用副本与账号数据，恢复本副本的 `napcat.mjs` 和父 loader，并将自身插件开关设为 false：

```sh
python3 bridge/qq/macos/install.py restore-bootstrap --install-dir "$RTC_INSTALL" --check
python3 bridge/qq/macos/install.py restore-bootstrap --install-dir "$RTC_INSTALL"
```

恢复前同时核对当前文件和原始备份的哈希；文件被改动或仍有本副本进程时不写入任何内容。备份与 `.restored.json` 清单会保留。恢复后 `run.py napcat` 将拒绝启动缺少桥接 hook 的实例；再次使用 RTC 桥时，安装到一个新目录，或先卸载此副本再全新安装。QQ 顶层入口不由此命令恢复，`gui` 模式仍可转入原始 QQ 入口；彻底移除副本使用下方卸载命令。

## 卸载

先用各终端的 Ctrl-C 结束本安装的两个前台进程。只删除带有匹配所有权标记的安装目录：

```sh
python3 bridge/qq/macos/install.py uninstall --install-dir "$RTC_INSTALL" --check
python3 bridge/qq/macos/install.py uninstall --install-dir "$RTC_INSTALL"
```

卸载检查 `ps` 中是否仍有本副本进程，发现后拒绝删除，不会终止其他 QQ。原 QQ、QQ 用户容器与 BlackHole 驱动保留；BlackHole 的移除由其 [官方说明](https://github.com/ExistentialAudio/BlackHole#uninstallation-instructions) 单独管理。

## 视频收发（实现已开放，等待 macOS 实机验收）

精确匹配 QQ 7.0.2-53644 的 ARM64 / x64 原生库后，私聊视频邀请、私聊屏幕共享邀请、群内摄像头/屏幕订阅，以及两条独立的发送渠道均已接入。原生指令、回调和切片地址见 [desktop-video-evidence.json](../bridge/qq/desktop-video-evidence.json)。Mac 无实机，因此这一状态表示实现和离线回归完成，**不表示 macOS 通话已经实测成功**。

- 接收只截取本插件的 QQ 原生解码窗口；每个订阅必须属于当前通话的实际参与者，并等到原生解码回调后才交付 JPEG。
- 发送可以选择实际枚举的摄像头、窗口、显示器、动态测试图，或 `external-frames`。摄像头与屏幕渠道可同时发送不同内容，均通过已有 `ctx.rtc` 接口操作。
- macOS 的 `getNativeWindowHandle()` 返回 NSView 指针。现在使用 Electron `getMediaSourceId()` 中的 CGWindowID，避免把 NSView 当成窗口号。显示器经专用 Electron capture session 转入自有窗口，不猜 QQ 的显示器编号。
- 窗口或显示器必须由用户/上层插件显式选择；选择过的来源消失就失败，不自动切成整个桌面。屏幕采集不附带系统音频；音频继续使用配置的虚拟音频链路。

允许专用 QQ Host 使用“摄像头”和“屏幕录制”权限。权限被拒绝时返回明确错误；安装器只为应用副本补齐缺少的 usage description，保留官方文案，修改后需按原步骤签名。屏幕录制权限改变后通常需要重启该 Host。来源枚举不生成截图缩略图，不等于启动发送。依据：[Electron 权限 API](https://www.electronjs.org/docs/latest/api/system-preferences)、[窗口来源 ID](https://www.electronjs.org/docs/latest/api/browser-window#wingetmediasourceid)。

任意帧经摄像头渠道输出还需要独立虚拟摄像头。macOS 13+ 使用 OBS 30+：安装 OBS，首次启动一次虚拟摄像头再停止，退出 OBS，随后让本插件独占它。安装 Python 依赖：

```sh
python3 -m venv "$RTC_INSTALL/video-venv"
"$RTC_INSTALL/video-venv/bin/python" -m pip install -r bridge/video/requirements.txt
```

从控制台视频来源中确认 `OBS Virtual Camera` 的真实 `camera:...` ID，去掉 `camera:` 前缀填入下方 `--qq-device-id`，不要凭显示名猜 ID：

```sh
node bridge/qq/scripts/configure-video.mjs \
  --bridge-dir "$RTC_INSTALL" \
  --python "$RTC_INSTALL/video-venv/bin/python" \
  --backend obs --device "OBS Virtual Camera" \
  --qq-device-id "此机实际枚举的相机ID"
```

脚本检查 Python 依赖并写 `runtime/video.json`，不打开设备、不拨号。已有配置须显式 `--replace`；只检查用 `--check`。首次实际启动仍会验证 pyvirtualcam 后端、设备和 QQ 枚举相符，不会回退到实体摄像头。OBS 同一实例不能同时作为另一个生产者占用；依据 [pyvirtualcam 官方说明](https://github.com/letmaik/pyvirtualcam#macos-obs)。

相机保持输入画面比例；需要兼容手机 QQ 竖屏显示时可显式使用 `framing: 'portrait-safe'`。QQ 客户端自身的横竖屏切换仍需要实机检查。ACK、帧渲染成功或写入虚拟设备均不宣称对方已收到画面。挂断后使用原生 GetChattingRoomId 读取实际空闲状态，队列 ACK 不被当作已挂断。

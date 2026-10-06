# Windows 10 快速准备

先完成安装准备，约定测试时再启动，**不要同时进行 Linux、Windows 两边的账号测试**。本包含源码与已编译入口，不含 QQ、NapCat、虚拟声卡驱动、node_modules、账号或 token。Windows 实际通话尚未验收。

1. 安装 **Node.js 22.19+ x64、Python 3.10+ x64**（加入 PATH）、Microsoft VC++ 2015–2022 x64 运行库，准备 **RX、TX 两条独立虚拟音频线路**。不要把真实麦克风或系统默认设备当作测试线路。

2. 解压 ZIP 中的 `KoishiRTC` 目录，例如放在 `C:\KoishiRTC`。在 PowerShell 安装运行依赖与音频环境：

   ```powershell
   cd C:\KoishiRTC
   npm install --omit=dev
   python -m venv .venv-rtc-audio
   .\.venv-rtc-audio\Scripts\python.exe -m pip install -r bridge\audio\requirements.txt
   ```

   保留 optional dependencies；独立控制台需要其中的 Koishi/console/auth/server/database-sqlite。运行不需要 `tsx`、TypeScript 编译或 `npm run build`。

3. 按 [Windows QQ 说明](qq-windows.md)下载并用 7-Zip 解压 **QQ 9.9.36-53644 x64** 的 `Files` 目录，以及官方 NapCat Shell x64 包。使用尚不存在的新目录准备副本（以下执行策略仅用于这个脚本进程）：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\qq\windows\rtc-qq.ps1 install -QQSource C:\RTCDownloads\QQ\Files -NapCatSource C:\RTCDownloads\NapCatShell -InstallDir C:\RTCQQ
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bridge\qq\windows\rtc-qq.ps1 doctor -InstallDir C:\RTCQQ
   ```

   安装器识别新版 NapCat 的官方插件白名单时，仅在此新副本加入明确的本地插件入口，保留原文件和哈希；不冒用官方插件 ID。若扫描结构未知会停止。首次测试建议使用单独 Windows 用户会话；程序目录独立不等于 QQ 原生账号目录已证实完全隔离。

4. 用实际测试 QQ 号生成新配置（替换下例 QQ 号）；已有配置会拒绝覆盖：

   ```powershell
   node bridge\qq\windows\configure-media.mjs --install-dir C:\RTCQQ --self-id 123456789 --python C:\KoishiRTC\.venv-rtc-audio\Scripts\python.exe
   ```

   此时 PortAudio 收发设备留空，尚不能录音。QQ 控制 token、媒体 token 和控制台密码分别保存在本地文件，打包时全部排除。不要把整个 runtime 目录发回来。

5. 等约定的 Windows 验收开始后，先退出使用同一 QQ 号的原桌面 QQ、其他 NapCat，以及另一台机器上的测试实例，再在两个新终端分别启动本组 Host、NapCat；按当前 NapCat 启动输出扫码登录测试账号。**一组 Host + NapCat 需要同时运行；不要再启动同账号的另一组实例或原桌面 QQ。** 新程序目录不能隔离账号的在线状态。

   ```powershell
   # 终端 1：原生 AVSDK Host
   node C:\KoishiRTC\bridge\qq\windows\manage.mjs run-av-host --install-dir C:\RTCQQ
   # 终端 2：独立 NapCat；按提示扫码登录
   node C:\KoishiRTC\bridge\qq\windows\manage.mjs run-napcat --install-dir C:\RTCQQ
   ```

6. 回到准备终端，先核对 `status` 的实际 QQ 号、`host-status` 的 `nativeProfile`/`ready`，再枚举原生设备：

   ```powershell
   node bridge\qq\windows\manage.mjs control --install-dir C:\RTCQQ --action status
   node bridge\qq\windows\manage.mjs control --install-dir C:\RTCQQ --action host-status
   node bridge\qq\windows\manage.mjs control --install-dir C:\RTCQQ --action devices
   ```

   把枚举里的真实 ID 与完整名称写进 `C:\RTCQQ\runtime\route.json`，**替换以下示例值**：

   ```json
   { "input": { "id": 12, "name": "实际 TX 录音端名称" }, "output": { "id": 34, "name": "实际 RX 播放端名称" } }
   ```

   ```powershell
   node bridge\qq\windows\manage.mjs control --install-dir C:\RTCQQ --action route --body-file C:\RTCQQ\runtime\route.json
   ```

   必须返回 `ready: true`；Host 每次重启都需重新选择。失败时先保留诊断，不能用默认麦克风代替。

7. 再在两个新终端启动媒体桥与控制台：

   ```powershell
   # 终端 3：媒体桥
   node C:\KoishiRTC\bridge\daemon.mjs C:\RTCQQ\runtime\bridge.json
   # 终端 4：已编译的 Koishi 控制台入口
   node C:\KoishiRTC\scripts\run-local-console.cjs
   ```

   打开 `http://127.0.0.1:6129/console/rtc`；登录信息在 `C:\KoishiRTC\runtime\console\config.json`。进入“实时通话”，先点“连接检查 → 检查”，选择“从 QQ 扬声器收音”和“向 QQ 麦克风发音”的设备，点“保存音频路由”后再检查：

   | 方向 | 第 6 步 AVSDK 设备 | 控制台里的 PCM 设备 |
   | --- | --- | --- |
   | 接收 RX | output = RX 播放端 | input = RX 录音端 |
   | 发送 TX | input = TX 录音端 | output = TX 播放端 |

   AVSDK 的设备 ID 与 PortAudio 的 `pa:...` ID 不相同。原生 `routeReady` 必须确认，PCM 设备诊断也必须通过；再对明确选定的测试对象拨打或接听。群语音目前收到混音，不能把它当作逐人音轨。

已有 Koishi 的用户可在本目录执行 `npm pack --ignore-scripts`，再从自己的 Koishi 项目安装生成的 `.tgz`；插件使用包内已编译的 `dist/index.cjs`。在 `bridges` 填写媒体桥地址、媒体 token、`onebot` 和实际 QQ 号。与独立控制台二选一连接同一个媒体桥；它一次只允许一个 Koishi 连接。完整配置见 [桌面媒体桥](desktop-bridge.md)。

问题反馈先提供 `doctor`、Host status 与控制台诊断结果；不要提供二维码、token、密码或账号数据库。Windows 设备移除、真实双向音频及群语音仍需按 [验收顺序](qq-windows.md#验收与退出)逐项确认。

结束测试时先挂断/退出群，再按 `C:\RTCQQ` 的程序路径确认这组 Host、NapCat 及其 QQ 子进程已退出，然后恢复原桌面 QQ。只关启动终端不保证 QQ 子进程已停止；不要误结束其他路径下的 QQ。

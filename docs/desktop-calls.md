# 微信、飞书与腾讯会议桌面语音

这里是运行在聊天客户端所在电脑上的桌面控制后端，复用 RTC daemon 的鉴权、通话租约和双向 PCM 音频接口。它不依赖 Koishi 适配器具备通话 API，也不登录或逆向托管这些平台的账户。用户先用官方客户端登录，再由明确绑定的本地无障碍接口操作客户端。

**当前交付范围：跨平台实现和离线回归已经完成，三款客户端均未做账号实测。** 预置流程是可编辑的校准起点，不能当作所有客户端版本都开箱即用。只有实际 UI 暴露所需账户、目标和通话证据，且完成下面的校准后，才开启操作。某个版本不暴露这些证据时，诊断会报 unavailable；没有坐标盲点、模拟成功或自动切换到其他账号。

| 平台 | 已实现流程 | 不宣称具备的能力 |
| --- | --- | --- |
| 微信 | 指定联系人私聊语音拨号；识别白名单来电、接听、拒接、挂断 | 微信群语音、视频、逐人音轨、实名验证 |
| 飞书 | 输入明确会议号加入已有会议、退出、双向混合音频 | 调用 OpenAPI 即等于入会；自动创建会议或邀请；逐人音轨 |
| 腾讯会议 | 输入明确会议号加入已有会议、退出、双向混合音频 | 自动创建会议或邀请；跳过登录、密码、主持人审批；逐人音轨 |

各 OS 使用 Windows UI Automation、macOS Accessibility、Linux AT-SPI。控制绑定可执行文件的规范绝对路径、主进程 PID 和进程创建时刻；macOS 还可绑定 bundle ID。多个同路径实例必须指定 `application.pid`。同名其他程序和 Chromium renderer 不会自动成为目标。

## 安装与音频连接

需要 Node.js、Python 3、官方客户端，以及两条独立的虚拟音频通道。请在虚拟环境安装 Python 包：

```bash
python3 -m venv --system-site-packages .venv-desktop
.venv-desktop/bin/python -m pip install -r bridge/desktop/requirements.txt
```

Windows 将命令中的解释器替换为 `.venv-desktop\Scripts\python.exe`。macOS 使用普通 venv 即可。

- Windows：`pywinauto` + `psutil`。桥与客户端保持同一普通用户权限；不要为绕开应用权限而默认用管理员运行。虚拟线路参考 [Windows 音频安装](windows-quickstart.md)。
- macOS：`pyobjc-framework-ApplicationServices`、`pyobjc-framework-Cocoa`、`psutil`。系统设置 → 隐私与安全性 → 辅助功能中授权实际运行 worker 的 Python/终端；音频桥还需麦克风权限。这个纯无障碍后端不截屏，不要求屏幕录制权限。虚拟线路使用两条可区分的 BlackHole/其他音频路由。
- Linux：发行版 `python3-pyatspi`（Ubuntu/Debian）与桌面会话的 AT-SPI/DBus 服务；venv 需可见系统包。Qt/Chromium 客户端必须实际提供无障碍树。没有 GUI 会话或树为空时不会退回截图猜测。音频使用已有 PulseAudio/PipeWire 桥。

两条线方向如下，**客户端的设备名称和桥的设备 ID 并不一定相同**：

```text
其他人 → 客户端扬声器 [接收线路] → audio.inputDevice → RTC PCM 接收
RTC PCM 发送 → audio.outputDevice → [发送线路] 客户端麦克风 → 其他人
```

`desktop.audioRoute.inputName` 是客户端麦克风所选设备的实际显示名；`outputName` 是客户端扬声器所选设备的实际显示名。两者必须不同。`audio.inputDevice/outputDevice` 则分别是桥的收音/播放设备 ID，也必须显式选择。**不能让桥收取自己的输出线路，也不能使用系统默认设备。** 设备名称核验只能证明软件选择；实际线路对应需要首次提示音/收音测试确认。

桌面模式禁止通过 WebUI 单独修改桥的音频设备，因为这会破坏与客户端配置成对的证据。修改线路时先停止桥，同步更新客户端设置、`desktop.audioRoute` 和 `audio`，再执行 `probe` 并重新启动。

## 生成配置

在插件源目录或 portable 包根目录执行。下面以 Linux 微信为例；Windows/macOS 使用它们的实际 exe/MacOS 主程序路径和 Python 路径：

```bash
node bridge/desktop/setup.mjs init \
  --directory /absolute/private/wechat-rtc \
  --platform wechat \
  --executable /absolute/path/to/official-client \
  --self-id your-actual-account-id \
  --python /absolute/path/to/.venv-desktop/bin/python \
  --input 'RTC Transmit' \
  --output 'RTC Receive' \
  --port 6140
```

其他平台：`--platform feishu` 或 `--platform tencent-meeting`；macOS 可加 `--bundle-id`。初始化只生成 `bridge.json`、`profile.json` 和 32 字节随机鉴权 token，不启动客户端、不开音频、也不开启通话权限。输出目录必须是新的；已有文件不会被覆盖。Windows 请将目录 ACL 限制为当前用户。

编辑 `bridge.json`：

- 设置 `audio.inputDevice` 和 `audio.outputDevice` 为现有音频诊断工具枚举到的明确设备 ID。
- 填写 `desktop.targets`，例如 `[{"id":"实际可验证的联系人ID","kind":"direct","name":"备注"}]`；会议为 `kind:"group"`。
- **targets 是操作白名单**。空列表不会允许任意拨号；请求中的 ID 和 kind 都必须匹配。`name` 仅供人阅读，不被当作目标身份。
- 会议号在 UI 中有空格或前缀时，按实际显示形式校准相应 selector；不要靠模糊匹配或截断 ID。
- 账户字段须与 Koishi RTC 的 `platform/selfId` 一致，不要把 QQ 的 `onebot` 身份填给微信或飞书。

先检查依赖，再以只读方式查看当前客户端树：

```bash
node bridge/desktop/setup.mjs doctor --python /absolute/path/to/python
node bridge/desktop/setup.mjs inspect --config /absolute/private/wechat-rtc/bridge.json --out /absolute/private/wechat-rtc/ui-idle.json
```

`inspect` 不点击、不拨号；输出只包含精确绑定应用的无障碍信息，没有密码输入框正文。它仍可能包含聊天文字，请仅保存在私有目录，不要整份公开上传。

## 校准真实 UI 与状态

每个 OS、每种客户端都有独立 `bridge/desktop/profiles/*.json`。Windows 微信预置的语音按钮、`mmui::VOIPWindow`、`mmui::VOIPTrayWindow`、`mmui::VOIPDurationTextView`、接听/拒绝名称，依据 [pywechat 上游](https://github.com/Hello-Mr-Crab/pywechat) 固定 commit `8589baa049bb91d3a500602c167f07b2f8397a13` 的公开控件声明。只引用控件事实，没有复制其点击坐标或全局键盘流程。4.1.8+ 语音与视频入口合并，需要根据实际菜单新增语义步骤，不能继续照用 4.1.7 入口。

飞书/腾讯会议预置了“加入会议 → 填写会议号 → 加入 → 退出”流程；依据 [飞书的加入会议说明](https://www.feishu.cn/hc/en-US/articles/360035058814-start-or-join-calls-and-video-meetings) 和 [腾讯会议桌面说明](https://meeting.tencent.com/support/topic/1759/index.html)。官方操作说明不是 UIA/AX/AT-SPI 控件树，因此各版本的控件字段仍须实际校准。macOS/Linux 的角色映射也必须以本机 inspector 为准。

校准内容：

1. `identity` 必须唯一识别登录账号的真实 `{self}`；显示名不唯一时用个人资料中的账户 ID。不可直接删除身份检查。
2. `target` 必须唯一识别通话中对方的 `{target}` 或实际会议号。若通话界面不显示 ID，需通过详情面板暴露并锚定它；不能把“有人接听”当成所拨目标正确。
3. `audioInput/audioOutput` 指向设置中的真实选中值，包含 `{input}/{output}`。有的客户端把文本放在 `name`，有的放在 `value` 或 `description`。
4. `states` 用真正的正向状态证据；`connected` 不能仅是“窗口存在”。微信默认使用通话计时控件，其他会议要校准真正已入会的 UI。`idle` 还应排除响铃/拨号/接通窗口。窗口消失或证据不明会停止媒体并显示 unknown，不自动当作挂断。
5. `actions` 最后一个步骤为单一 `commit:true` 的语义按钮，之前只导航、填入 ID 或断言。不得包含多个拨号/接听按钮。会议 `join.target` 可用输入框 `value:"{target}"` 验证提交目标；接通后仍由根 `target` 验证会议 ID。

Selector 只支持精确 `role/name/value/automationId/description/className` 和 `ancestor` 层级，匹配零个或多个都失败。无正则猜测、`found_index`、坐标、全局快捷键或模糊昵称匹配。worker 在执行最终按钮前会再次读取新树，复验账号、目标、路由、状态与按钮本身，避免准备时正确、点击时已换人。

## 设置预检与通话中的证据

默认 `evidenceMode:"preflight"`：

- `preflight` 导航至账号/音频设置，验证三类证据，最后关闭设置。该过程只允许 invoke/assert/verify，不写配置，不提交电话。
- 每次拨号或接听前重新预检。初次启用和空闲证据过期后也会核验；失败后间隔 30 秒再尝试，不每 500 毫秒反复开设置。
- 核验结果绑定进程 generation、账号/配置指纹，以及正在进行的通话 ID。通话中设置面板可以关闭；只有同一目标和真实通话状态确认时才维持媒体。
- 空闲证据默认有效 5 分钟，`desktop.evidenceMaxAgeMs` 范围 1 秒至 1 小时；同一已确认的通话期间延续，进程重启或配置变化立即失效。
- 无法持续探测用户在通话中手动修改隐藏设置或换账号。诊断明确提示此边界；共享操作客户端期间应暂停桥。若客户端能一直暴露真实账号和设备选择，可设 `continuous`，每次轮询都核验。

完成 selector 调整后，先单独执行设置导航核验：

```bash
node bridge/desktop/setup.mjs probe --config /absolute/private/wechat-rtc/bridge.json
```

`probe` 会操作配置中的设置按钮，**不会调用 dial/join/accept，不打开音频，也不会把 profile 自动标记为已校准**。首次请保持客户端可见观察导航；失败停在当前界面，便于修正 selector。`validate` 则始终只读当前树，隐藏的设置证据显示缺失是正常的，不能据此断言 `probe` 已通过。

请在真人协助下分别检查 idle、来电/拨号、接通、挂断状态树及目标身份；只有这些证据对应无误，才将 `profile.json` 的 `calibrated` 改为 `true`。随后启动：

```bash
node bridge/daemon.mjs /absolute/private/wechat-rtc/bridge.json
```

Koishi 配置选择桌面桥、同一账户平台与 ID、上述本机 URL 和私有 token。更换客户端版本后先恢复 `calibrated:false`，重新 inspector/probe/实测，不沿用不明控件。

## 验收范围与失败处理

离线测试覆盖：账号/目标/路由错误拒绝调用、白名单、幂等请求、进程重启、来电打断、已提交但结果未知、真实状态恢复、隐藏设置预检、缓存绑定、执行前目标切换守卫、初始化和诊断。它们证明程序的协议与边界，不能替代三款客户端在 Windows/macOS/Linux 的实际收音、发音与 UI 控件验收。

如果应用不提供可用树、按钮不支持 Invoke/AXPress/AT-SPI 动作、账号或通话目标无法唯一验证，本版本会明确拒绝，不退回模拟成功。此时需要该客户端的专用原生后端或版本适配，不能简单把 `calibrated:true` 当成修复。会议密码、入会审批、设备系统权限等仍由用户完成，不会绕过。

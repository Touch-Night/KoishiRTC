# Telegram 普通用户账号安装与登录

Telegram 桥接使用普通用户账号的持久 Telethon 会话。安装、登录和运行 sidecar 是三个独立步骤；安装与 `doctor` 都不登录、不创建通话，也不打开摄像头或麦克风。

## 安装隔离依赖

在项目根目录运行：

```bash
python3 bridge/telegram/setup.py install --venv runtime/telegram-venv
python3 bridge/telegram/setup.py doctor --venv runtime/telegram-venv
```

需要 Python 3.10 及以上和可用的 `venv`/`pip`。安装目录也可通过 `--venv` 明确指定；默认是项目下的 `runtime/telegram-venv`，不会向系统 Python 安装这些包。Windows 使用该虚拟环境的 `Scripts/python.exe`，Linux/macOS 使用 `bin/python`。

本桥接固定以下直接依赖版本：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| py-tgcalls | 3.0.0 | Telegram 通话协议与媒体接口 |
| ntgcalls | 3.0.1 | 原生通话引擎 |
| Telethon | 1.45.0 | 普通用户账号 MTProto 会话 |
| Pillow | 12.3.0 | 外部 JPEG 帧编解码 |

版本于 2026-10-06 核对自官方 PyPI：[py-tgcalls](https://pypi.org/project/py-tgcalls/3.0.0/)、[NTgCalls](https://pypi.org/project/ntgcalls/3.0.1/)、[Telethon](https://pypi.org/project/Telethon/1.45.0/)、[Pillow](https://pypi.org/project/Pillow/12.3.0/)。传递依赖由 pip 按这些版本声明的依赖范围解析。

Linux ARM64 已核实并实际安装 CPython 3.12 的 `ntgcalls-3.0.1-cp312-cp312-manylinux_2_28_aarch64.whl`，需要 glibc 2.28 及以上。安装器要求 NTgCalls 和 Pillow 使用预编译 wheel；没有对应平台/Python wheel 时会失败，不会静默改为现场编译原生引擎。

上游此版本支持 Windows AMD64、Linux x86_64/aarch64 和 macOS 14+ ARM64。**Telegram 后端暂不支持 Intel Mac**，并非所有 Mac 都可安装；依据与其他平台限制见[Telegram 能力说明](telegram.md)。本限制不影响独立的 QQ macOS 后端。

`doctor` 在独立进程中检查固定版本、导入 PyTgCalls/Telethon、构造并释放 `NTgCalls()`，再做内存中的 JPEG 编解码。NTgCalls 3.0.1 没有全局 `close()` 接口，检查通过释放对象及结束子进程清理原生资源。成功输出 JSON 中 `nativeSmoke`、`jpegCodec` 为 `true`，`accountConnected` 为 `false`；这只确认本机依赖可加载，不代表 Telegram 网络、账号登录或实际通话已通过。

## 准备本地账号配置

从 Telegram 官方 [API Development tools](https://my.telegram.org/apps) 获取自己的 `api_id` 和 `api_hash`，参见 [Telethon 登录说明](https://docs.telethon.dev/en/stable/basic/signing-in.html)。使用本地编辑器创建 `runtime/telegram/config.json`，不要将真实凭据粘贴到命令参数、环境变量、聊天或项目源码中。

```json
{
  "apiId": 123456,
  "apiHash": "0123456789abcdef0123456789abcdef",
  "selfId": "123456789",
  "sessionPath": "/absolute/path/to/KoishiRTC/runtime/telegram/account.session"
}
```

示例值必须替换。`selfId` 是打算使用的普通用户账号的数字 ID，不是手机号、用户名、Bot token 或应用 `apiId`。登录完成后会校验它与实际账号一致。`sessionPath` 必须是以 `.session` 结尾的绝对路径，登录工具和 sidecar 使用同一文件；相对路径和内存/StringSession 不接受。

将账号配置和会话放在专用私有目录中。Linux/macOS 可这样设置权限：

```bash
mkdir -p runtime/telegram
chmod 700 runtime/telegram
chmod 600 runtime/telegram/config.json
```

登录工具会拒绝对其他用户开放的会话目录，并将会话文件权限收紧到 `600`。Windows 请用当前用户专属目录和文件 ACL 控制访问。会话包含可继续登录的授权信息，应与 `apiHash` 一样保密；不要提交、打包发布或发给他人。参见 [Telethon 会话文件说明](https://docs.telethon.dev/en/stable/concepts/sessions.html)。

## 由账号所有者显式登录

先停止使用同一 session 的 Telegram sidecar，然后由账号所有者在本机交互终端运行：

```bash
runtime/telegram-venv/bin/python bridge/telegram/login.py --config runtime/telegram/config.json
```

工具依次使用隐藏输入读取国际格式手机号、Telegram 登录验证码，以及账号启用两步验证时的密码。输入不回显，不保存手机号、验证码或密码，不输出 API hash 或 session 内容。无可隐藏输入的终端时会拒绝提示，不回退到明文读取。错误输出不会转发 Telegram 原始异常或 traceback。

已有有效 session 时，工具直接校验当前普通用户身份并退出，不重复发送验证码。账号为 Bot 或与 `selfId` 不一致时会失败，不自动替换账号或注销已有 session。若确实需要更换账号，请先停止 sidecar，再在配置中指定另一个私有 `.session` 路径后显式登录。登录不会发送消息、加入群组、呼叫其他账号或修改通话状态。

成功提示只表示普通用户会话已保存且账号身份匹配。随后在 provider 配置中指定该虚拟环境的 Python、此 JSON 的 `configPath` 和相同 `selfId`；允许访问的会话由 provider 的 `allowedChatIds` 单独配置。sidecar 只使用现有已授权 session，登录交互不会落入后台进程。

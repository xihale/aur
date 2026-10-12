# zcode-headless: 无 GUI 后端模式

## 原理

ZCode Desktop 是 Electron 应用 = GUI(窗口/渲染/GPU) + Node 后端(host 进程做实际 AI 工作)。
后端以独立 Node bundle 形式打包在 `/usr/lib/zcode/glm/zcode.cjs`,通过标准输入输出说
ZCode Protocol (JSON-RPC)。**不需要 GUI 即可运行。**

反编译结构(`app.asar` 解包后):

```
out/main/     Electron 主进程 (窗口管理, fork host)
out/host/     后端业务逻辑 (通过 utilityProcess.fork 启动, 与 main 用 MessagePort 通信)
out/scheduler/ 定时任务
out/renderer/ 前端 (React, ~290MB 资源, 纯 GUI 用)
glm/zcode.cjs 独立 CLI/后端 (node bundle, 12MB, 可脱离 Electron 运行)
```

## 内存实测

| 模式 | RSS |
|---|---|
| 完整 GUI(主+GPU+渲染+host+cli+repl 全家桶) | ~3.8 GB |
| headless app-server(纯后端) | ~0.4 GB |

## 用法

```
zcode-headless                  # stdio JSON-RPC 服务(默认 app-server --stdio)
zcode-headless prompt "任务"    # 单次 prompt, 结果直接打印
zcode-headless serve 8819       # 需 socat, TCP 桥接 RPC
zcode-headless doctor           # 诊断
zcode-headless login            # 一次性 OAuth 登录(写 API key 到配置)
```

### RPC 协议示例

每行一条 JSON。带 workspace 参数的方法需要:

```json
{"id":1,"method":"session/list","params":{"workspace":{"workspaceKey":"/path","workspacePath":"/path"}}}
```

主要方法: `session/create`, `session/list`, `session/read`, `session/send`,
`session/stop`, `session/fork`, `workspace/setDefaultModel`, `plugins/list`, `mcp/list` 等。

`session/create` 会反向请求 `session/requestRuntimePreferences`,客户端需回复
`{nativeSearchEnhancementsEnabled, memoryEnabled, askUserQuestionAutoResolutionEnabled,
modelContextBudgetStrategy}` (15s 超时)。

## 认证(重要)

- 会话/工作区/插件与桌面版共用 `~/.zcode`,但**模型认证不共用**:
  - 桌面版: OAuth token 加密存于 `~/.zcode/v2/credentials.json` (AES-256-GCM,
    key=sha256("zcode-credential-fallback:linux:$HOME:$USER"),密文格式 `enc:v1:iv.tag.ct`)。
    但桌面版对大模型 API 走 token 刷新流程,headless CLI 期望的是静态 API key,
    直接把 JWT 塞进 `provider.*.options.apiKey` 会在请求签名时失败 (V4 signing)。
  - headless: 跑一次 `zcode-headless login` (浏览器 OAuth),最终 API key 写入
    `~/.zcode/cli/config.json` 的 `provider.<id>.options.apiKey`,之后 `prompt`/`serve` 即可无 GUI 长跑。

## 待验证/限制

- `tui` 子命令需要 SEA 运行时(`zcode-tui-runtime`),本 node bundle 未附带,会报
  `Cannot find package '@zcode/tui'`。桌面版的终端内嵌 TUI 用的是别的通道。
- `--settings` 仅 `tui` 子命令支持;`--prompt` 只读默认路径 `~/.zcode/cli/config.json`。

## systemd user service

包内附带 `zcode-headless.service`(装到 `/usr/lib/systemd/user/`),把 app-server 桥到
TCP 127.0.0.1:8819(socat fork 模式,每个 TCP 连接一个独立 app-server 进程):

```
systemctl --user enable --now zcode-headless   # 开机自启 + 立即启动
journalctl --user -u zcode-headless -f         # 看日志
```

客户端示例(Python):

```python
import socket, json
s = socket.create_connection(('127.0.0.1', 8819), timeout=10)
req = {"id": 1, "method": "session/list",
       "params": {"workspace": {"workspaceKey": "/path", "workspacePath": "/path"}}}
s.sendall((json.dumps(req) + '\n').encode())
s.settimeout(10)
buf = b''
while b'\n' not in buf:
    buf += s.recv(65536)   # 必须读到换行才算一条完整响应
print(json.loads(buf.split(b'\n')[0]))
```

实测常驻开销:socat ~8 MB,app-server 按连接惰性拉起(~0.4 GB/连接,空闲可断开)。
`NODE_OPTIONS=--max-old-space-size=1024` 限制了单实例 V8 堆。

## 手机配对(zcode-relay 守护进程)

之前手机端"等待桌面端配对"卡住,是因为配对要求**桌面设备**在 relay 上注册,
而 `zcode-headless.service` 只是本地 stdio/TCP 桥,不在 relay 上。

`zcode-relay.js` 解决此问题:以桌面设备身份连接 `wss://zcode.z.ai/ws?mid={mid}`
(`device_register_init`/`auth_init role:device` + HMAC proof),认证后回答
`pair_status_query → matched`,手机即可完成配对。凭证自动从桌面端数据读取:

- `deviceMid` ← `~/.zcode/v2/telemetry-state.json`
- `deviceSid` ← `~/.zcode/v2/setting.json` 的 `webRemoteControlExternalRelayDevice.deviceSid`(无则自动注册并写回)
- `passHash` ← `~/.zcode/v2/credentials.json` 键 `web-remote-control:external-relay:pass_hash`(enc:v1,解密同前)

服务:`systemctl --user enable --now zcode-relay`(包内 unit 名 `zcode-relay.service`)。

当前已实现的桥接(配对后):L2 `bootstrap-response`/`workspace-list-response`/
`workspace-bridge-open→ready`;L4 `zcode-agent` 通道经 rpc-frame ↔ 本地 app-server
`session/create|send|stop` 最小翻译(会话行以 assistantText 快照形式下发)。
完整的 L4 通道(终端/文件/权限卡 UI 等)仍在桌面 host 进程里,后续按需补充。

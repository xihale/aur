# zcode-bin

智谱 ZCode（Electron 桌面版）的 Arch 打包，带一层**隐私/安全加固**：把上游静默的工作区快照上传和遥测外呼在网络边界与数据两层做掉。上游细节见逆向审计笔记（`zcode-snapshot-poison` / `09-egress-telemetry-audit`）。

## 仓库结构

```
PKGBUILD            makepkg 入口（source= 只留上游 .deb 的 sha256 pin）
patches/            构建期改树脚本（prepare() 阶段运行，全部 fail-open）
  lean.js             引擎 env 门控：工具黑名单 + description 截断
  sleep-inhibit.js    引擎行为补丁：有 turn/compact 在跑时抑制系统睡眠，空闲释放
  block-install.js    把网络拦截器装进 asar（记录 realMain、写规则 JSON）
  telemetry.js        数据层兜底：代码里所有 *.aliyuncs.com 端点改写为 127.0.0.1
  verify-build.js     构建期验证闸门（fail-closed，见下）
runtime/            随包分发的运行时载荷
  block.cjs           声明式出网拦截核心（node:http(s)/fetch/net/tls/undici）
  block.mjs           Electron 主进程引导（接管 package.json main，再进真实入口）
  relay.js            手机配对中继守护进程（配合 zcode-relay.service）
launchers/          启动器（安装为 /usr/bin/zcode 与 /usr/bin/zcode-headless）
units/              systemd 用户单元（headless serve / relay）
tests/              自测：blocker 行为矩阵 / lean+sleep-inhibit fixture / 上游语料回归 / 审计 diff
HEADLESS.md         无 GUI 运行说明
```

## 隐私加固机制

两层防御，全部**结构无关**——不锚定压缩代码形状，上游重构/改名不影响：

1. **网络层（block.cjs / block.mjs）**：`package.json "main"` 被换成 bootstrap，先在
   node:http(s)、global fetch、undici（require hook）、net/tls 套接字和 Chromium
   session.webRequest 上按规则拦截，再动态 import 记录在 `realMain` 的真实入口。
   纯 Node 子进程（引擎等）通过 `NODE_OPTIONS=--require zcode-block.cjs` 注入。
   被拦请求重定向到 `127.0.0.1:1`（瞬断 ECONNREFUSED，调用方走正常错误路径）。
2. **数据层（telemetry.js）**：bundle 内所有 `https://*.aliyuncs.com` 字符串改写为
   `127.0.0.1`，兜住任何绕过网络层的路径（服务端动态下发的 URL 由网络层按 host 规则拦）。

默认规则：host 后缀 `aliyuncs.com`、路径前缀 `/api/v1/snapshot/`。

## 睡眠抑制（sleep-inhibit.js）

引擎的 turn 全部经原型方法 `executeTurnCommand`/`executeManualCompact` 进入，补丁在
原型装配处把函数值包一层：调用即持一把 logind `sleep:idle` block 锁（引用计数 +
`systemd-inhibit` 子进程组），promise settle 即释放——成功/失败/取消各出口由
`.then(rel, rel)` 统一收口，不会漏。防孤儿：hold 进程由 `/usr/bin/timeout -k 10
21600` 封顶（父进程被 SIGKILL 后锁最多再活 6h），看门狗每 30min 续租、子进程意外
死亡自动重拉，hold 连续秒死 3 次判为环境不可用并永久静默降级。

开关：`ZCODE_SLEEP_INHIBIT=0` 关闭；`ZCODE_SLEEP_INHIBIT_DEBUG=1` 在 stderr 打
acquire/release 日志；`ZCODE_SLEEP_INHIBIT_CMD` 可替换 hold 命令（测试钩子）。

## 规则维护

规则字面量只有一个家：`runtime/block.cjs` 的 `DEFAULT_RULES`。构建时
`block-install.js` 从它派生出 `zcode-block.json` 随包分发，装好的系统与裸环境
不会各自漂移。运行时临时加规则用环境变量，不用重打包：

```bash
ZCODE_BLOCKLIST='{"blockHostSuffix":["example.com"]}' zcode
ZCODE_BLOCK_DEBUG=1 zcode   # 打印每次拦截
```

防"厂商搬家"的观测面（默认关，隐私包不该偷偷记日志）：

```bash
ZCODE_BLOCK_AUDIT=/tmp/egress.txt zcode          # 记录每个出网 host 一次
tests/run.sh audit-diff /tmp/egress.txt          # 允许放行的=策略盲区,过目后改 DEFAULT_RULES
```

全量测试（上游语料回归，慢；deb 语料放仓库根目录即可被自动发现）：

```bash
tests/run.sh upstream          # 或 tests/run.sh upstream 3.12.3 指定版本
```

所有 patch 均为 fail-open：锚点/入口失配时告警跳过，构建不炸、应用不被破坏。
但 fail-open 只属于运行时——**构建期是 fail-closed 的**：`patches/verify-build.js`
在 prepare() 尾部断言入口已替换、realMain 可解析、引擎带 lean + sleep-inhibit 标记、
黑名单域名零残留，任何一条不满足直接让 makepkg 失败（一个"静默失配"的补丁不许出厂）。
`makepkg` 默认还会跑 `check()`（blocker 行为矩阵 + lean fixture，回环不出网）。

## 构建

```bash
makepkg -f
sudo pacman -U zcode-bin-<版本>-x86_64.pkg.tar.zst
```

## 上游升级流程

1. 改 `PKGBUILD` 的 `pkgver`，更新 `source=` 里 .deb 的 sha256；
2. `makepkg -f` —— 各 patch 自报状态（OK / 已跳过），构建日志里确认 `lean-patch: OK`
   与 `block-install: main -> zcode-block.mjs`；
3. 如 lean patch 报锚点失配，在 bundle 里 grep `cachedTools` 看属性是否改名，改
   `patches/lean.js` 的 `ANCHOR_RE`（属性名锚点，一般不需要动）。

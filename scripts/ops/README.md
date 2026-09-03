# scripts/ops — hermes-web-ui 服务器运维脚本

针对生产机 `hs.xlingo.fun` 的两类防护：**SQLite 损坏**（2026-08 事故）和**内存/OOM**
（2026-09 事故）。**升级后需要重跑安装脚本**，原因见下。

## 快速用法

```bash
# 每次 npm i -g hermes-web-ui 升级之后跑这个
./scripts/ops/install-db-guard.sh

# 只重打 VACUUM 补丁（升级后最小动作）
./scripts/ops/install-db-guard.sh --patch-only

# 内存防护：swap 守卫（每 5 分钟，装一次就行）
./scripts/ops/install-swap-guard.sh
./scripts/ops/install-swap-guard.sh --dry-run    # 只记日志不动手，先观察

# 换机器
DEPLOY_HOST=root@1.2.3.4 ./scripts/ops/install-db-guard.sh
```

服务器上的日常命令：

```bash
hermes-db-guard check                    # 立即体检，只读
hermes-db-guard restore <db路径>          # 从最新健康备份恢复（先停服务）
hermes-db-guard ensure-patch             # 查/补 VACUUM 补丁
journalctl -t hermes-db-guard -p err     # 只看告警
journalctl -t hermes-webui-watchdog      # 看服务被拉起的记录
journalctl -t hermes-swap-guard          # 看 swap 回收记录
journalctl -u earlyoom | grep "sending SIG"   # 谁被 earlyoom 杀了

# 关掉某个自带 MCP toolset（无头服务器上 browser 暴露 0 个工具）
set-studio-mcp-enabled.py hermes-studio-browser false --dry-run
set-studio-mcp-enabled.py hermes-studio-browser false && systemctl restart hermes-webui
```

## 历史：runtime-versions 权限问题（0.7.1，已由上游修掉）

0.7.1 升级后除 `admin` 以外 6 个账号都建不了 hermes 会话：`ChatPanel` 拿
`GET /api/hermes/runtime-versions`（`requireSuperAdmin`）判断 runtime 装没装，
普通 admin 拿到 403，客户端把它当成"没装"推去 `hermes.agentManager`，而那个路由
自己是 `meta.requiresSuperAdmin`，守卫又把人弹回聊天页。

当时前后端各打了一层补丁。**上游在 0.7.13 的 #2805 里彻底修了**：新增无角色守卫的
`GET /api/agents/availability` 专门回答这个问题，catch 里也不再跳转。所以两层补丁
都已撤除，服务端那个 bundle 补丁脚本一并删掉——不再需要，也不用每次升级重打。

约束由 `tests/client/chat-panel-runtime-probe-permission.test.ts` 接管：建会话
不得依赖 super_admin 专属端点，探测失败不得跳转。

## 事故背景（2026-08-27 → 08-29）

`xiao/state.db` 的 b 树指向了文件之外的页，`GET /api/hermes/sessions/hermes/groups` 报 500。链条是：

1. 8/27 07:50 应用检测到 schema 异常，自动修复升级到 Strategy 2 —— 删掉 FTS schema 后 `VACUUM`。
2. VACUUM 把库从 21278 页重写压缩到约 15420 页。但当时同一 cgroup 里还有约 69 个进程（gateway / bridge / cron / web_server）以 WAL 模式持有同一个库，它们的页映射还是 VACUUM 之前的。
3. 这些旧连接继续写入的 WAL 帧带着 `db_size=21278`，帧内 b 树单元指向 15536..21278 页 —— 收缩后已不存在。
4. 这些帧被 checkpoint 落盘，主文件的 b 树从此带着越过文件末尾的悬空指针。**修复之后写入的每一行（id ≥ 8600）都落在这片毒区。**
5. 无人发现，直到 ~48 小时后接口 500。**1095 行消息永久丢失**（窗口 8/27 00:16 → 8/28 07:30）。

证据：`PRAGMA integrity_check` 报 8553 条错误、坏页号最高 20923；WAL 里两代 salt 混存、`db_size_after_commit` 同时存在 15535 和 21278 两个矛盾值、`max page# in WAL = 20924`；主文件不带 WAL 单独检查同样报错，说明悬空指针已落盘。

`hermes_state.py` 自己的注释警告过这个场景（"other gateway/cron/worker connections may still hold it open... is unsafe"），但那条警告只用来保护 `journal_mode` 切换，没有覆盖 VACUUM 路径。

## 四层防护

### 1. `patch-vacuum-guard.py` — 根因补丁

`hermes_state.py` 里本来就有 `count_db_holders()`（Linux-only、不抛异常、无外部依赖），**但从未被调用**。补丁把它接到 Strategy 2 的 VACUUM 之前：有别的进程持有就跳过 VACUUM，只记 error。

删 FTS schema 才是真正的修复动作，VACUUM 只是回收空间。跳过它会留下空闲页（无害，日后离线 VACUUM 可回收），比在几十个进程脚下收缩文件安全得多。

补丁是幂等的：已打过就直接退出；改完自动 `py_compile`，语法错则从备份回滚。

**⚠️ 升级会冲掉它。** `hermes_state.py` 属于 hermes-agent 包，`npm i -g` / pip 升级会整体替换该文件。`hermes-db-guard sweep` 每次跑都会检查补丁标记并自动重打，所以最坏情况是裸奔一个 sweep 周期（≤24h），不是永久失守。想立刻闭合就升级后跑 `install-db-guard.sh --patch-only`。

### 2. 6 小时只读体检 — `hermes-db-check.timer`

01/07/13/19:43 跑 `quick_check`，不写盘。这次从坏到被发现隔了约 48 小时，中间多丢了一整天数据；这一层把发现窗口压到约 6 小时。

### 3. 每日体检 + 滚动备份 — `hermes-db-guard.timer`

04:17 跑。要点：

- 用 `sqlite3 .backup` 而不是 `cp`。对活跃的 WAL 库做裸 `cp` 会得到撕裂文件，那种"备份"等于没有。
- 每份备份**存盘前先自检**，不合格立即丢弃。未经验证的备份只是猜测。
- **坏库不备份**，避免用坏数据覆盖仍然健康的历史备份。
- 保留 `KEEP_DAYS`（默认 7）天，按 mtime 而不是文件个数 —— "能回退多久"是时间问题。

实测 9 个库 12.8 秒跑完，压缩后约 62 MB/次，7 天滚动约 430 MB。

**不自动恢复。** 坏库意味着接口不可用，但用一份最多 24 小时前的备份静默覆盖线上库，那是 cron 替人做的数据丢失决定。脚本只告警，`restore` 由人执行。

### 4. `hermes-webui-watchdog.sh` — 服务自杀防护

8/29 12:17:51 服务被自己 cgroup 里的 agent 会话 `systemctl stop` 掉了 —— 日志里能看到与整个 cgroup 一起被 SIGKILL 的 `bash`(3584807) 和 `systemctl`(3584809)。`KillMode=mixed` 把发起命令的 systemctl 也杀了，所以 `restart` 的 start 阶段从未执行；而 `Restart=always` **对显式 stop 不生效**，于是服务躺了 3 小时 31 分无人发现。

Watchdog 每 2 分钟检查一次，**连续两次**确认 enabled 但 inactive 才动手 —— 单次可能正落在一次正常重启（npm 升级、部署）中间，抢它就是跟操作者对着干；正常重启只停约 10 秒，等不到第二次检查。

区分"人想停"和"服务自杀"无法从 stop 事件本身判断，所以用比进程活得更久的意图标记：

| 想让它停手 | 作用范围 |
|---|---|
| `systemctl disable hermes-webui` | 永久（watchdog 只认 `is-enabled == enabled`） |
| `touch /run/hermes-webui.admin-stop` | 到下次重启 |
| `touch /etc/hermes-webui.admin-stop` | 永久 |

## 内存事故（2026-09-02）：看起来像崩溃，其实是 earlyoom

`hermes-webui` 从 09:27 到 10:18 每 45~55 秒挂一次，10 分钟 12 次重启，线上全 502。
**它没有崩。** systemd 记的是 `Deactivated successfully`（退出码 0），错误日志一个字
没写，应用日志每轮只有一行 `[shutdown] Received signal: SIGTERM`，journal 里也没有
`Stopping`。凶手是 earlyoom（`/etc/default/earlyoom`，`-m 18,9 -s 25,12`）：

```
earlyoom: low memory! at or below SIGTERM limits: mem 18.00%, swap 25.00%
earlyoom: sending SIGTERM to process 997200 uid 0 "MainThread": badness 690
```

链条有四环，缺一环都不会形成循环：

1. **chrome 泄漏**。`agent-browser`（`packages/ekko-agent/src/tools/browser.ts` 调的
   预编译 Rust CLI，comm 截断成 `agent-browser-l`）每个会话起一棵 chrome，而当时仓库
   **从不发 `agent-browser close`**——超时和 abort 的 SIGTERM 只打到短命的 CLI 客户端。
   08:14 起约 20 棵 chrome 与之前几小时的残留同时活着，earlyoom 一小时发了 1823 个
   kill（chrome 1828 次 / MainThread 29 次）。**已修**，见下面的「源码层收尾」。
2. **swap 被 nginx 锁死**。openresty + BT-WAF 的 worker 涨到独占 1.02 GB swap（单个
   worker 615 MB），而 earlyoom 的 `--avoid` 列表里有 `nginx`，这块 swap 永远回收不了。
   swap 空闲一路掉到 7%。
3. **AND 门变单门**。earlyoom 要 mem 和 swap 同时低于阈值才动手；swap 长期 <25%，于是
   只剩「可用内存 <18%」这一道。
4. **启动突发自己撞门**。9 个 profile 的 gateway + 两套 MCP 扇出，50 秒内涨到 2.1 GB，
   每次都跌破 18% → 被杀 → `Restart=always` 拉起 → 再涨。自我维持。

两个反直觉的点，改配置前务必知道：

- **earlyoom 的 `--prefer ^(claude|node|...)$` 对 node 完全失效**：Node ≥20 把主线程
  comm 设成 `MainThread`，本机所有 node 服务同名。真正有用的是 2026-09-02 补上的
  `chrome|chromium|headless_shell|agent-browser-l`——一次性的、杀掉零代价，
  必须排在任何常驻服务前面。
- **本机 `oom_score` 几乎没有分辨力**。`/proc/pid/oom_score` = `(1000 + 用量占比×1000) × 2/3`，
  基线 666，每 57 MB 才 +6.7 分。实测 webui 686 / gateway 682 / BT-Panel 684，全在噪音里；
  webui 主进程因为累积 swap 和 10 GB VmSize 的页表常年略高一点，于是稳定中标。
- **别用 `OOMScoreAdjust` 保 webui**：它会被 cgroup 内所有子进程继承，等于把 chrome 一起
  保护起来。`--avoid ^MainThread$` 同理，会顺带保护所有 node 服务。

### 恢复步骤（已验证）

```bash
touch /run/hermes-webui.admin-stop     # 挡住 watchdog
systemctl stop hermes-webui
/etc/init.d/nginx reload               # 宝塔用 sysv 脚本；systemctl show nginx 的 MainPID=0
free -m                                # 确认 swap 空闲 > 25%
rm -f /run/hermes-webui.admin-stop
systemctl reset-failed hermes-webui && systemctl start hermes-webui
```

`nginx reload` 是关键动作，不是顺手做的：swap 空闲 13.7% → 47.6%，循环立刻停。
**`swapoff -a` 绝对不能用**——要把 1.6 GB 换回只有 700 MB 空闲的内存里，机器会假死。

### 5. `hermes-swap-guard.sh` — swap 守卫

每 5 分钟看一次 `SwapFree/SwapTotal`，低于 30% 才动作：先把前五名 swap 持有者写进日志
（下次不是 nginx 时，这条日志是唯一线索），然后 reload nginx 退休臃肿 worker，30 分钟内
不重复 reload。

还有第二步，来自这次的教训：nginx.conf **没设 `worker_shutdown_timeout`**，被 reload
退休的 worker 会一直等到自己所有连接关闭为止——socket.io 的 websocket 让一个 worker 在
reload 之后又活了 2 小时 36 分，手里一直攥着 289 MB swap。所以守卫在 swap 仍然偏低时，会
给「shutting down 状态超过 10 分钟」的 worker 发 SIGTERM。它持有的 websocket 会断一下，
socket.io 自动重连，比让整个服务进重启循环便宜得多。

实测：手工干掉那个卡住的 worker，swap 空闲 668 MB → 947 MB，可用内存 512 MB → 1624 MB。

### 6. `set-studio-mcp-enabled.py` — 削减 MCP 扇出

自带 4 个 MCP server（`api` / `browser` / `devices` / `use`）是模块级常量
（`studio-autoinject.ts` 的 `MANAGED_SERVERS`），没有任何配置能改这个集合；而且**派生进程
有两个独立 owner**：每个 profile 的 gateway 一套，agent-bridge 的 per-profile worker
启动时又一套（`chat-run.ts` 的恢复轮询会把近 8 天内有会话的 profile 全部物化）。9 个 profile
实测出 **80 个 `hermes-studio-mcp.mjs`（合计 2634 MB RSS）+ 41 个 watchdog**。

无头 Linux 上 `browser` toolset 暴露 **0 个工具**——它只是 Electron Desktop browser broker
的 HTTP 客户端，服务器上那个 broker 根本不存在。关掉它是零功能损失：

| | 关之前 | 关之后 |
|---|---|---|
| MCP node 进程 | 80（2634 MB RSS） | 60（1774 MB RSS） |
| watchdog | 41 | 31 |
| cgroup 进程 / 线程 | 96 / 539 | 76 / 438 |

脚本按行改 YAML（不重排、不丢注释），每个文件改前留 `.bak-<ts>`，幂等，`--dry-run` 可预演。
**注意**：注入器一旦发现四个条目里有任何一个被 disable，就会跳过该 profile 的整体 re-sync
（`studio-autoinject.ts`），所以每次 `npm i -g hermes-web-ui` 之后要重跑一次并确认其余三个
条目仍指向新的安装路径。

### 7. 源码层收尾：`agent-browser close`

运维脚本只能收拾后果，源头在代码里，已一并修掉：

- `packages/ekko-agent/src/tools/browser.ts` 现在登记每个起过守护进程的会话，并导出
  `closeBrowserSession` / `closeAllBrowserSessions` / `sweepOrphanBrowserSessions`
  （`agent-browser --session <name> --json close`）。
- 接入点：`bootstrap/lifecycle.ts` 的 shutdown 步骤「Agent browser sessions」，以及
  `modules/studio/sockets/chat-run.ts` 的 `disposeSession` / `clearSessionHistory`。
- 会话按 `browserSessionId`（= 聊天 session id）哈希，**多轮对话共用同一棵浏览器**，
  所以不能在单次 run 结束时关——否则每个追问都要重开 Chrome。
- 全是 best-effort：socket 目录不存在就直接返回（否则 CLI 会**新建**一个守护进程），
  失败只记日志并丢掉登记项，5 秒超时后 SIGKILL 那个 CLI。生产 `TimeoutStopSec=10`，
  收尾不能拖过它。
- 覆盖测试 `tests/ekko-agent/browser-teardown.test.ts`（9 例）。

仍然管不到的两种：模型用 `terminal_exec` 自己起的 `agent-browser`（连
`AGENT_BROWSER_IDLE_TIMEOUT_MS` 都拿不到），以及本进程被 SIGKILL 后的残留——后者要靠
`sweepOrphanBrowserSessions()`，它默认不调用，因为同机第二个 Studio 进程会被误伤。

## 验证记录

上线前逐项实测过，不是纸面设计：

- 补丁：`py_compile` 通过、模块正常导入、`count_db_holders()` 对线上库返回 1。
- 告警链路：故意构造坏库放进扫描路径 → 检出 → `exit=1` → 以 err 优先级进日志并附恢复命令 → 拒绝备份坏库 → 健康库照常备份 → 清理后恢复 `exit=0`。
- `restore`：3000 行的库打坏后恢复，行数与 `quick_check` 均正确，坏文件留作 `state.db.replaced-<ts>` 而非删除。
- Watchdog：在一次性单元 `wd-probe` 上复现了 8/29 场景（显式 stop 后 `Restart=always` 确实救不回来），第一次检查只置标记、第二次拉起；对 disabled 单元完全不插手。
- Swap 守卫：健康时静默退出（swap 空闲 48% → 无输出、exit 0）；`LOW_PCT=90 DRY_RUN=1` 强制走完全流程，正确列出持有者并给出 would-reload / would-SIGTERM。第一版有个自匹配 bug——`ps | awk '/nginx: worker process is shutting down/'` 会匹配到 awk 自己的命令行，已用 `$3 == "nginx:"` 修掉。
- MCP 削减：`--dry-run` 预演 9 个文件；实际改动逐文件 `diff` 确认**只有一行**（`enabled: true` → `false`），9 个文件 `yaml.safe_load` 全部通过，`api`/`devices`/`use` 与用户自己加的 `memorys` 条目未被触碰；重启后 browser 进程归零，其余 toolset 各 20 个照常在跑，站点 200。
- 源码收尾：`tests/ekko-agent/browser-teardown.test.ts` 9 例全过（登记、按原始 id 或 `e_<hash>` 关闭、无守护进程时不 spawn、shutdown 全关、失败仍丢登记项、spawn 异常不抛、超时 SIGKILL、孤儿清扫）；`packages/server` 与 `packages/ekko-agent` 的 `tsc --noEmit` 干净；`npm run harness:check` 通过。`tests/ekko-agent` 里另有 26 例 Windows 环境预存失败（断言硬编码 `/tmp` 和 Unix 命令），与本次改动无关。
- earlyoom：改后 `journalctl -u earlyoom` 明确回显了新的 `--prefer` 正则，说明正则被接受而不是被静默忽略。

## 已知边界

- **Linux only。** `count_db_holders()` 和 watchdog 都依赖 `/proc`。
- **补丁与"服务器只用 npm 升级"的约定有出入。** 它修改服务器上的 agent Python 文件。之所以必须这样：`hermes_state.py` 里没有任何 env 或配置开关能关掉自动修复或 VACUUM（只有 `database.journal_mode` 一个开关），不改代码就防不住根因。
- **`journal_mode=DELETE` 不是替代方案。** 它防的是 WAL 相关的另一类问题，对 VACUUM 收缩文件与并发持有者冲突这个根因没有直接作用。
- **磁盘。** 备份目录会长到约 430 MB（7 天）。这台机 40G 已用 89%，余量只剩 4.5G，`KEEP_DAYS=3` 可减半。
- **swap 守卫只会回收 nginx。** 它的动作是 reload nginx / 干掉退休 worker；如果下次占 swap
  的是别的进程（实测名单里还有宝塔的 `monitor` 98 MB、`BT-Panel`、`YDService`、`octopus`），
  它只会把持有者写进日志然后交给 earlyoom。日志里那行 top holders 就是给这种情况留的。
- **chrome 泄漏的源头已修，但没修全。** `browser.ts` 的收尾覆盖 shutdown 和会话
  删除/清空；模型用 `terminal_exec` 自己起的 `agent-browser` 仍然只能等它自己的
  10 分钟 idle 计时，本进程被 SIGKILL 后的残留也要手动 `sweepOrphanBrowserSessions()`。
  earlyoom 的 `--prefer` 加了 chrome，算是最后一道兜底。
- **结构性过量承诺。** 3.7 GB 内存 + 1.99 GB swap 上跑 9 个 profile，`Committed_AS` 约
  200%。削掉 browser toolset 之后仍有 76 个进程 / 1.86 GB。想要真正的余量，只能减少
  autostart 的 profile 数（`gatewayAutoStart.include`）、切 `management='unified'`（代价：
  非 default profile 失去独立飞书/微信/QQBot 入口），或者加内存。

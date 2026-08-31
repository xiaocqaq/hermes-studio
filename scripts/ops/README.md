# scripts/ops — hermes-web-ui 服务器运维脚本

针对生产机 `hs.xlingo.fun` 的 SQLite 损坏防护。**升级后需要重跑安装脚本**，原因见下。

## 快速用法

```bash
# 每次 npm i -g hermes-web-ui 升级之后跑这个
./scripts/ops/install-db-guard.sh

# 只重打 VACUUM 补丁（升级后最小动作）
./scripts/ops/install-db-guard.sh --patch-only

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

## 验证记录

上线前逐项实测过，不是纸面设计：

- 补丁：`py_compile` 通过、模块正常导入、`count_db_holders()` 对线上库返回 1。
- 告警链路：故意构造坏库放进扫描路径 → 检出 → `exit=1` → 以 err 优先级进日志并附恢复命令 → 拒绝备份坏库 → 健康库照常备份 → 清理后恢复 `exit=0`。
- `restore`：3000 行的库打坏后恢复，行数与 `quick_check` 均正确，坏文件留作 `state.db.replaced-<ts>` 而非删除。
- Watchdog：在一次性单元 `wd-probe` 上复现了 8/29 场景（显式 stop 后 `Restart=always` 确实救不回来），第一次检查只置标记、第二次拉起；对 disabled 单元完全不插手。

## 已知边界

- **Linux only。** `count_db_holders()` 和 watchdog 都依赖 `/proc`。
- **补丁与"服务器只用 npm 升级"的约定有出入。** 它修改服务器上的 agent Python 文件。之所以必须这样：`hermes_state.py` 里没有任何 env 或配置开关能关掉自动修复或 VACUUM（只有 `database.journal_mode` 一个开关），不改代码就防不住根因。
- **`journal_mode=DELETE` 不是替代方案。** 它防的是 WAL 相关的另一类问题，对 VACUUM 收缩文件与并发持有者冲突这个根因没有直接作用。
- **磁盘。** 备份目录会长到约 430 MB（7 天）。这台机 40G 用了 83%，留意余量；`KEEP_DAYS=3` 可减半。

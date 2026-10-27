#!/usr/bin/env bash
#
# 本机直接发布自定义前端 → hs.mxiao.top（不经 GitHub CI，不从 runner 构建）
#
# 为什么有这条路径：CI 的 deploy 步骤目标是另一台机器（hs.xlingo.fun /
# 115.159.206.76）的 SSH，而那台机现在 22 端口不可达；本机站点 hs.mxiao.top
# 的发布本来就走本地 /usr/local/sbin/hermes-frontend-release。所以日常发版
# 直接在本机做，一次命令走完 构建 → 打包 → 交给 root 接收端 → 自检。
#
# 用法：
#   bash scripts/deploy-frontend-local.sh                # 构建 + 发布（无变化则跳过）
#   bash scripts/deploy-frontend-local.sh --force         # 即使入口 bundle 没变也发
#   bash scripts/deploy-frontend-local.sh --skip-build    # 复用现有 dist/client
#   bash scripts/deploy-frontend-local.sh --check         # 发布前先跑 client 测试 + 类型检查
#   bash scripts/deploy-frontend-local.sh --keep 3        # 保留最近几个 release（默认 3，见 KEEP 处注释）
#   bash scripts/deploy-frontend-local.sh --dry-run       # 只构建 + 检查，不发布
#
# 只发前端：不跑 npm、不 restart hermes-webui，用户正在跑的 agent 会话不受影响。
# 落盘/切 root/reload/自检/回滚/清理旧 release 全在 root 接收端里：
#   /usr/local/sbin/hermes-frontend-release
#
set -euo pipefail

SITE='hs.mxiao.top'
RECEIVER="${RECEIVER:-/usr/local/sbin/hermes-frontend-release}"
INCOMING_DIR="${INCOMING_DIR:-/var/lib/hermes-deploy/incoming}"
KEEP=3   # 接收端清理旧 release 的保留数；实际有效上限也是 3：disk-watchdog 的 6d 段会把超出最新 3 个的 release 裁掉
SKIP_BUILD=0
FORCE=0
DO_CHECK=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --force)      FORCE=1; shift ;;
    --check)      DO_CHECK=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --keep)       KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
    -h|--help)    sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------------------------------------------------------------- 1. 可选闸门
if [ "$DO_CHECK" -eq 1 ]; then
  echo "==> 类型检查"
  node node_modules/vue-tsc/bin/vue-tsc.js -b --force
  echo "==> client 测试"
  npx vitest run tests/client
fi

# ---------------------------------------------------------------- 2. 构建
if [ "$SKIP_BUILD" -eq 1 ] && [ -f dist/client/index.html ]; then
  echo "==> 跳过构建，复用 dist/client"
else
  echo "==> 构建前端（vite build）"
  rm -rf dist/client
  node node_modules/vite/bin/vite.js build
fi

[ -f dist/client/index.html ] || { echo "!! dist/client/index.html 不存在" >&2; exit 1; }
BUNDLE="$(grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' dist/client/index.html | head -1)"
[ -n "$BUNDLE" ] || { echo "!! index.html 里找不到入口 bundle" >&2; exit 1; }
FILES="$(find dist/client -type f | wc -l)"
echo "==> 本地产物入口：${BUNDLE}（${FILES} 个文件，$(du -sh dist/client | cut -f1)）"

# ---------------------------------------------------------------- 3. 和线上比
# 入口 bundle 名 = 内容 hash，所以同名即内容一致。一致就没必要多一个几百 M
# 的 release 目录，除非显式 --force。
LIVE_HTML="$(curl -sS --max-time 15 --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/" || true)"
LIVE_BUNDLE="$(printf '%s' "$LIVE_HTML" | grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' | head -1 || true)"
echo "==> 线上入口：${LIVE_BUNDLE:-<读取失败>}"
if [ "$FORCE" -eq 0 ] && [ -n "$LIVE_BUNDLE" ] && [ "$LIVE_BUNDLE" = "$BUNDLE" ]; then
  echo "==> 入口一致（${BUNDLE}），线上已是最新，跳过发布。要强制发布加 --force。"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> --dry-run：到此为止，未发布。"
  exit 0
fi

# ---------------------------------------------------------------- 4. 打包上传
TS="$(date +%Y%m%d-%H%M%S)"
NAME="frontend-${TS}-$$.tgz"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
tar -czf "$TMPD/$NAME" -C dist client
mkdir -p "$INCOMING_DIR"
mv "$TMPD/$NAME" "$INCOMING_DIR/$NAME"
echo "==> 已投递 ${INCOMING_DIR}/${NAME}（$(du -h "$INCOMING_DIR/$NAME" | cut -f1)）"

# ---------------------------------------------------------------- 5. 触发发布
echo "==> 调用接收端发布（root）"
"$RECEIVER" "$NAME" --keep "$KEEP"

# ---------------------------------------------------------------- 6. 发布后自检
echo "==> 发布后自检"
sleep 1
AFTER_HTML="$(curl -sS --max-time 15 --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/")"
AFTER_BUNDLE="$(printf '%s' "$AFTER_HTML" | grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' | head -1)"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/${AFTER_BUNDLE}")"
echo "    首页      -> 200? $([ "${CODE}" = 200 ] && echo ok || echo "FAIL(${CODE})")"
echo "    入口      -> ${AFTER_BUNDLE}"
echo "    /chat     -> $(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/chat")"
echo "    /settings -> $(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve "${SITE}:443:127.0.0.1" "https://${SITE}/settings")"
echo "    vhost root:"; grep -n 'root /www/sites' /opt/1panel/www/conf.d/${SITE}.conf | sed 's/^/      /'
if [ "$AFTER_BUNDLE" != "$BUNDLE" ]; then
  echo "!! 线上入口 ($AFTER_BUNDLE) 与本次构建 ($BUNDLE) 不一致" >&2
  exit 1
fi
echo "==> 发布完成：${AFTER_BUNDLE}"

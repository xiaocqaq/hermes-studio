#!/usr/bin/env bash
#
# 把本地构建的自定义前端发布到 hs.xlingo.fun。
#
# 这台服务器上「线上前端」不是 npm 包里的 dist/client —— nginx 的 root 指向
# /www/wwwroot/hs.xlingo.fun/releases/<时间戳>-frontend，npm 装的那份 dist/client
# 没有任何东西去 serve 它。所以发布 = 传一个新的 release 目录 + 改 root + reload。
#
# 本脚本【绝不碰后端】：不跑 npm i -g，不 restart hermes-webui。
# 只 reload nginx，旧 worker 会把手上的请求和 websocket 处理完才退出，
# 正在跑的 agent 会话不受影响，零中断。
# 后端升级是另一件事，攒到手头没有正在跑的会话时单独做：
#   npm i -g hermes-web-ui@<版本> && systemctl restart hermes-webui   # 这个会掐断会话
#
# 分工：本地只负责 构建 → 打包 → 上传 → 触发；落盘/切 root/reload/自检/回滚
# 全在服务器端的 scripts/ops/hermes-frontend-release 里（root 运行）。
# 这样 GitHub Actions 用一个无特权的 deploy 用户就能发版，而且两条路径共用
# 同一份发布逻辑，不会各自漂移。装接收端见 scripts/ops/install-deploy-user.sh。
#
# 用法：
#   bash scripts/deploy-frontend.sh                # 构建 + 发布
#   bash scripts/deploy-frontend.sh --skip-build   # 复用现有 dist/client
#   bash scripts/deploy-frontend.sh --keep 3       # 发布后只保留最近 3 个 release
#   DEPLOY_HOST=deploy@1.2.3.4 bash scripts/deploy-frontend.sh
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@115.159.206.76}"
SITE="${SITE:-hs.xlingo.fun}"
INCOMING_DIR="${INCOMING_DIR:-/var/lib/hermes-deploy/incoming}"
RECEIVER="${RECEIVER:-/usr/local/sbin/hermes-frontend-release}"

SKIP_BUILD=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep) KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# CI 把专用 key 写到 SSH_IDENTITY；本地不设则走 ssh 默认身份。
# IdentitiesOnly 避免 runner 上其它 key 先被试、撞上 MaxAuthTries。
ssh_opts=(-o BatchMode=yes)
if [ -n "${SSH_IDENTITY:-}" ]; then
  ssh_opts+=(-o IdentitiesOnly=yes -i "$SSH_IDENTITY")
fi
ssh_() { ssh "${ssh_opts[@]}" "$DEPLOY_HOST" "$@"; }

# ---------------------------------------------------------------- 1. 构建
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> 构建前端"
  # 只跑 vite build：dist/server 由服务器上的 npm 包提供，这里不需要。
  # 类型检查是独立的一步，需要时手动跑 node node_modules/vue-tsc/bin/vue-tsc.js -b
  node node_modules/vite/bin/vite.js build
fi

[ -f dist/client/index.html ] || { echo "dist/client/index.html 不存在，先构建" >&2; exit 1; }
BUNDLE="$(grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' dist/client/index.html | head -1)"
[ -n "$BUNDLE" ] || { echo "index.html 里找不到入口 bundle" >&2; exit 1; }
echo "==> 本地产物入口：${BUNDLE}（$(find dist/client -type f | wc -l) 个文件）"

# ---------------------------------------------------------------- 2. 打包上传
# 文件名带随机后缀：接收端只认 [A-Za-z0-9._-]+.tgz，且并发发布不会互相踩。
TS="$(date +%Y%m%d-%H%M%S)"
NAME="frontend-${TS}-$$.tgz"
LOCAL_TARBALL="$(mktemp -d)/${NAME}"

echo "==> 打包上传 ${NAME}"
tar -czf "$LOCAL_TARBALL" -C dist client
scp "${ssh_opts[@]}" -q "$LOCAL_TARBALL" "${DEPLOY_HOST}:${INCOMING_DIR}/${NAME}"
rm -rf "$(dirname "$LOCAL_TARBALL")"

# ---------------------------------------------------------------- 3. 触发发布
# 落盘、切 root、nginx reload、自检重试、失败回滚、清理旧 release 全在服务器端。
# sudo -n：没有 tty，拿不到密码就直接失败，不要挂在那里等。
echo "==> 触发服务器端发布"
ARGS=''
[ "$KEEP" -gt 0 ] && ARGS="--keep ${KEEP}"
ssh_ "sudo -n ${RECEIVER} ${NAME} ${ARGS}"

# ---------------------------------------------------------------- 4. CDN 侧确认
echo "==> CDN 侧确认"
cdn_bundle="$(curl -sS "https://${SITE}/" --max-time 30 | grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' | head -1 || true)"
cdn_code="$(curl -sS -o /dev/null -w '%{http_code}' "https://${SITE}/${BUNDLE}" --max-time 60 || true)"
echo "    CDN index.html 指向：${cdn_bundle:-<拉取失败>}"
echo "    CDN 新入口：HTTP ${cdn_code}"

if [ "$cdn_bundle" = "$BUNDLE" ]; then
  echo "==> 发布完成，CDN 已是新版本"
else
  echo "==> 源站已切换（服务器端自检已通过）；CDN 边缘最多 5 分钟内自动跟上"
  echo "    急的话去腾讯云 CDN 控制台刷一下 https://${SITE}/ 这一个 URL 即可"
fi

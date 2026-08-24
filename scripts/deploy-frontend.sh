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
# 用法：
#   bash scripts/deploy-frontend.sh                # 构建 + 发布
#   bash scripts/deploy-frontend.sh --skip-build   # 复用现有 dist/client
#   bash scripts/deploy-frontend.sh --keep 3       # 发布后只保留最近 3 个 release
#   DEPLOY_HOST=root@1.2.3.4 bash scripts/deploy-frontend.sh
#
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@115.159.206.76}"
SITE="${SITE:-hs.xlingo.fun}"
RELEASES_DIR="${RELEASES_DIR:-/www/wwwroot/${SITE}/releases}"
VHOST_CONF="${VHOST_CONF:-/www/server/panel/vhost/nginx/${SITE}.conf}"
# 过渡期把上一个 release 的 assets 并进来，见下面「为什么」。设 0 关闭。
MERGE_PREV="${MERGE_PREV:-1}"

SKIP_BUILD=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --keep) KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ssh_() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }

# ---------------------------------------------------------------- 1. 构建
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> 构建前端"
  # 只跑 vite build：dist/server 由服务器上的 npm 包提供，这里不需要。
  # 类型检查是独立的一步，需要时手动跑 node node_modules/vue-tsc/bin/vue-tsc.js -b
  node node_modules/vite/bin/vite.js build
fi

[ -f dist/client/index.html ] || { echo "dist/client/index.html 不存在，先构建" >&2; exit 1; }
BUNDLE="$(grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' dist/client/index.html | head -1)"
echo "==> 本地产物入口：${BUNDLE}（$(find dist/client -type f | wc -l) 个文件）"

# ---------------------------------------------------------------- 2. 打包上传
TS="$(ssh_ 'date +%Y%m%d-%H%M%S')"
DEST="${RELEASES_DIR}/${TS}-frontend"
TARBALL="/tmp/${SITE}-frontend-${TS}.tgz"

echo "==> 打包上传到 ${DEST}"
tar -czf "$TARBALL" -C dist client
scp -o BatchMode=yes -q "$TARBALL" "${DEPLOY_HOST}:${TARBALL}"
rm -f "$TARBALL"

# ---------------------------------------------------------------- 3. 落盘（此时还没接流量）
ssh_ "bash -s" <<REMOTE
set -euo pipefail
DEST='${DEST}'; TARBALL='${TARBALL}'; CONF='${VHOST_CONF}'
RELEASES='${RELEASES_DIR}'; MERGE_PREV='${MERGE_PREV}'; TS='${TS}'

# 从 vhost 里读出当前 release，而不是猜
PREV="\$(grep -oP '(?<=root )\S+(?=;)' "\$CONF" | grep -F "\$RELEASES" | head -1 || true)"
echo "    当前 release：\${PREV:-<无>}"

STAGE="/tmp/stage-\${TS}"
mkdir -p "\$DEST" "\$STAGE"
tar -xzf "\$TARBALL" -C "\$STAGE"
cp -a "\$STAGE/client/." "\$DEST/"
rm -rf "\$STAGE" "\$TARBALL"

# 为什么要并入上一版的 assets：CDN 强制 index.html max-age=300，切 root 后最多 5 分钟内
# 仍有边缘节点吐旧的 index.html，它引用的旧 hash 资源在新目录里不存在 → 404 白屏。
# 资源名带内容 hash，所以合并绝对安全（同名即同内容），cp -n 不覆盖新文件。
if [ "\$MERGE_PREV" = "1" ] && [ -n "\$PREV" ] && [ -d "\$PREV/assets" ]; then
  cp -rn "\$PREV/assets/." "\$DEST/assets/" 2>/dev/null || true
  echo "    已并入上一版 assets（过渡期防 404）"
fi

chown -R root:root "\$DEST"
chmod -R a+rX "\$DEST"
echo "    落盘完成：\$(find "\$DEST" -type f | wc -l) 个文件"

# ------------------------------------------------------------ 4. 切 root + reload
cp -a "\$CONF" "\${CONF}.bak.\${TS}"
if [ -n "\$PREV" ]; then
  sed -i "s#\${PREV}#\${DEST}#g" "\$CONF"
else
  echo "!! vhost 里没找到 releases 路径，请手动确认 root" >&2; exit 1
fi
echo "    新 root：\$(grep -n 'root .*releases' "\$CONF" | head -1)"

if nginx -t >/dev/null 2>&1; then
  nginx -s reload
  echo "    nginx reload OK（优雅，不中断会话）"
else
  echo "!! nginx -t 失败，回滚 vhost" >&2
  cp -a "\${CONF}.bak.\${TS}" "\$CONF"
  nginx -t && nginx -s reload
  exit 1
fi

# ------------------------------------------------------------ 5. 源站自检
sleep 1
code=\$(curl -sS -k -o /dev/null -w '%{http_code}' -H "Host: ${SITE}" "https://127.0.0.1/${BUNDLE}" --max-time 20)
echo "    源站新入口 ${BUNDLE}：HTTP \$code"
[ "\$code" = "200" ] || { echo "!! 新入口拉不到，vhost 备份在 \${CONF}.bak.\${TS}" >&2; exit 1; }

served=\$(curl -sS -k -H "Host: ${SITE}" https://127.0.0.1/ --max-time 20 | grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' | head -1)
echo "    源站 index.html 指向：\$served"
[ "\$served" = "${BUNDLE}" ] || { echo "!! 源站仍在吐旧入口" >&2; exit 1; }

# ------------------------------------------------------------ 6. 清理旧 release
if [ "${KEEP}" -gt 0 ]; then
  # || true：没有匹配项时 ls 返回非 0，配合 pipefail 会误判整个发布失败
  (ls -1d "\$RELEASES"/*-frontend 2>/dev/null | sort | head -n -${KEEP} || true) | while read -r old; do
    # 用 if 而不是 [ ] && continue：后者在条件为假时返回 1，set -e 会直接中止循环
    if [ "\$old" = "\$DEST" ]; then continue; fi
    rm -rf "\$old" && echo "    清理旧 release：\$(basename "\$old")"
  done
fi
REMOTE

# ---------------------------------------------------------------- 7. CDN 侧确认
echo "==> CDN 侧确认"
cdn_bundle="$(curl -sS "https://${SITE}/" --max-time 30 | grep -o 'assets/js/index-[A-Za-z0-9_-]*\.js' | head -1 || true)"
cdn_code="$(curl -sS -o /dev/null -w '%{http_code}' "https://${SITE}/${BUNDLE}" --max-time 60 || true)"
echo "    CDN index.html 指向：${cdn_bundle:-<拉取失败>}"
echo "    CDN 新入口：HTTP ${cdn_code}"

if [ "$cdn_bundle" = "$BUNDLE" ]; then
  echo "==> 发布完成，CDN 已是新版本（release ${TS}）"
else
  echo "==> 源站已切换；CDN 边缘最多 5 分钟内自动跟上（index.html max-age=300）"
  echo "    急的话去腾讯云 CDN 控制台刷一下 https://${SITE}/ 这一个 URL 即可"
fi
echo "    回滚：把 ${VHOST_CONF} 换成 ${VHOST_CONF}.bak.${TS} 后 nginx -s reload"

#!/usr/bin/env bash
#
# 在服务器上装出一个「只能发前端」的 deploy 用户，供 GitHub Actions 使用。
#
# 为什么不直接把 root key 给 GitHub：这台机器 PermitRootLogin yes +
# PasswordAuthentication yes，22 端口对公网开放。CI 的私钥存在别人的
# 基础设施上，一旦泄露等于整台机器。所以给它一个能力被削到最小的身份：
#
#   deploy 能做的事，穷举：
#     1. scp 一个 tarball 到 /var/lib/hermes-deploy/incoming/
#     2. sudo /usr/local/sbin/hermes-frontend-release <文件名> [--keep N]
#   除此之外没有 sudo 权限，不能读 vhost，不能碰后端，不能 restart 任何服务。
#
# 用法（在服务器上以 root 运行）：
#   bash install-deploy-user.sh --pubkey 'ssh-ed25519 AAAA... deploy@github'
#   bash install-deploy-user.sh --pubkey-file /root/deploy.pub
#   bash install-deploy-user.sh --show          # 只看当前状态
#   bash install-deploy-user.sh --uninstall     # 拆掉
#
set -euo pipefail

DEPLOY_USER='deploy'
DEPLOY_HOME="/home/${DEPLOY_USER}"
INCOMING_DIR='/var/lib/hermes-deploy/incoming'
RECEIVER='/usr/local/sbin/hermes-frontend-release'
SUDOERS_FILE='/etc/sudoers.d/hermes-frontend-deploy'
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PUBKEY=''
MODE='install'

die() { echo "!! $*" >&2; exit 1; }

[ "$(id -u)" = '0' ] || die '需要 root'

while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY="${2:?--pubkey 需要内容}"; shift 2 ;;
    --pubkey-file) PUBKEY="$(cat "${2:?--pubkey-file 需要路径}")"; shift 2 ;;
    --show) MODE='show'; shift ;;
    --uninstall) MODE='uninstall'; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

if [ "$MODE" = 'show' ]; then
  echo '=== deploy 用户 ==='
  id "$DEPLOY_USER" 2>/dev/null || echo '(不存在)'
  echo '=== authorized_keys ==='
  if [ -f "${DEPLOY_HOME}/.ssh/authorized_keys" ]; then
    ssh-keygen -lf "${DEPLOY_HOME}/.ssh/authorized_keys" 2>/dev/null || cat "${DEPLOY_HOME}/.ssh/authorized_keys"
  else
    echo '(无)'
  fi
  echo '=== incoming ==='
  ls -ld "$INCOMING_DIR" 2>/dev/null || echo '(无)'
  echo '=== 接收脚本 ==='
  ls -l "$RECEIVER" 2>/dev/null || echo '(无)'
  echo '=== sudo 白名单 ==='
  cat "$SUDOERS_FILE" 2>/dev/null || echo '(无)'
  echo '=== deploy 实际能用的 sudo ==='
  sudo -l -U "$DEPLOY_USER" 2>/dev/null | tail -5 || true
  exit 0
fi

if [ "$MODE" = 'uninstall' ]; then
  rm -f "$SUDOERS_FILE" && echo "已删 ${SUDOERS_FILE}"
  # 保留接收脚本：手动发布也用它
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    userdel -r "$DEPLOY_USER" 2>/dev/null && echo "已删用户 ${DEPLOY_USER}" || echo "!! userdel 失败，手动检查" >&2
  fi
  rm -rf "$(dirname "$INCOMING_DIR")" && echo '已删 incoming'
  echo '完成。接收脚本保留在 '"$RECEIVER"'（手动发布仍需要它）'
  exit 0
fi

[ -n "$PUBKEY" ] || die '缺少 --pubkey / --pubkey-file'
echo "$PUBKEY" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) ' \
  || die '公钥格式不对（应以 ssh-ed25519 / ssh-rsa / ecdsa-sha2-nistp256 开头）'

echo '==> [1/5] deploy 用户'
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "    已存在，跳过创建"
else
  # 需要真 shell：scp 和 sudo 都要靠它。锁密码 → 只能用密钥登录。
  useradd -m -s /bin/bash -c 'hermes frontend deploy (CI)' "$DEPLOY_USER"
  passwd -l "$DEPLOY_USER" >/dev/null
  echo "    已创建（密码已锁，仅密钥登录）"
fi

echo '==> [2/5] authorized_keys'
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
AK="${DEPLOY_HOME}/.ssh/authorized_keys"
# 收紧这把 key 的能力：不给端口/agent/X11 转发，不执行用户 rc。
# 不用 command="..." 强制命令：这把 key 要跑两条不同的命令（scp + sudo 发布）。
OPTS='no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc'
KEYLINE="${OPTS} ${PUBKEY}"
touch "$AK"
FPR="$(echo "$PUBKEY" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}' || true)"
if [ -n "$FPR" ] && ssh-keygen -lf "$AK" 2>/dev/null | grep -qF "$FPR"; then
  echo "    这把 key 已在，跳过（${FPR}）"
else
  printf '%s\n' "$KEYLINE" >> "$AK"       # 追加，不覆盖已有的 key
  echo "    已追加（${FPR:-指纹未知}）"
fi
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$AK"
chmod 600 "$AK"

echo '==> [3/5] incoming 目录'
install -d -m 755 -o root -g root "$(dirname "$INCOMING_DIR")"
# 只有这一个目录 deploy 可写；1777 那种全局可写不要，精确给 owner
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$INCOMING_DIR"
echo "    ${INCOMING_DIR}（属主 ${DEPLOY_USER}，仅此处可写）"

echo '==> [4/5] 接收脚本'
[ -f "${SRC_DIR}/hermes-frontend-release" ] || die "找不到 ${SRC_DIR}/hermes-frontend-release"
# 0755 root:root —— deploy 只能执行，不能改。这条是整个模型的地基：
# 脚本可写就等于 root 可写，白名单也就白给了。
install -m 755 -o root -g root "${SRC_DIR}/hermes-frontend-release" "$RECEIVER"
echo "    ${RECEIVER}（root:root 0755，deploy 只能执行）"

echo '==> [5/5] sudo 白名单'
# 只放这一条命令。参数不在 sudoers 里限制 —— 校验在接收脚本内部做，
# 那里能读文件、能查 tar 清单，比 sudoers 的字符串匹配可靠得多。
# NOPASSWD 是必须的：CI 没有 tty，也不该持有服务器密码。
cat > "${SUDOERS_FILE}.tmp" <<EOF
# 由 scripts/ops/install-deploy-user.sh 生成 —— 手改会在下次安装时被覆盖
# ${DEPLOY_USER} 只能执行前端发布脚本，别无其他特权
Defaults:${DEPLOY_USER} !requiretty
${DEPLOY_USER} ALL=(root) NOPASSWD: ${RECEIVER}
EOF
chmod 440 "${SUDOERS_FILE}.tmp"
chown root:root "${SUDOERS_FILE}.tmp"
# 先 visudo -c 验语法再落位：坏掉的 sudoers 会让全机 sudo 失效
if visudo -cf "${SUDOERS_FILE}.tmp" >/dev/null 2>&1; then
  mv "${SUDOERS_FILE}.tmp" "$SUDOERS_FILE"
  echo "    ${SUDOERS_FILE} 语法通过并已生效"
else
  rm -f "${SUDOERS_FILE}.tmp"
  die 'sudoers 语法检查失败，未改动任何东西'
fi

echo
echo '=== deploy 实际拿到的权限 ==='
sudo -l -U "$DEPLOY_USER" 2>/dev/null | tail -5 || true
echo
echo '装好了。本地验证："ssh deploy@<host> sudo -n '"$RECEIVER"' --help"'

#!/usr/bin/env bash
# install-swap-guard.sh — install/refresh the swap guard that keeps earlyoom
# away from hermes-webui. Idempotent; safe to re-run.
#
# See hermes-swap-guard.sh for the incident this prevents (2026-09-02: nginx
# workers sat on 1.02 GB of swap, which armed earlyoom's swap threshold
# permanently and turned every hermes-webui boot burst into a SIGTERM).
#
# Usage:
#   ./install-swap-guard.sh
#   DEPLOY_HOST=root@1.2.3.4 ./install-swap-guard.sh
#   ./install-swap-guard.sh --dry-run     # install, but the guard only logs
#   ./install-swap-guard.sh --uninstall
set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-root@115.159.206.76}
SBIN=${SBIN:-/usr/local/sbin}
LOW_PCT=${LOW_PCT:-30}
MIN_INTERVAL=${MIN_INTERVAL:-1800}
SHUTDOWN_GRACE=${SHUTDOWN_GRACE:-600}
DRY_RUN=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/hermes-swap-guard.sh" ] || { echo "missing $HERE/hermes-swap-guard.sh" >&2; exit 1; }

echo "==> target: $DEPLOY_HOST"

if [ "$UNINSTALL" = "1" ]; then
  ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "
    systemctl disable --now hermes-swap-guard.timer 2>/dev/null || true
    rm -f /etc/systemd/system/hermes-swap-guard.{service,timer} '$SBIN/hermes-swap-guard'
    systemctl daemon-reload
    echo '    removed'
  "
  exit 0
fi

echo "==> [1/2] guard script"
scp -q -o ConnectTimeout=20 "$HERE/hermes-swap-guard.sh" \
  "$DEPLOY_HOST:$SBIN/hermes-swap-guard"

echo "==> [2/2] systemd timer"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "bash -s" <<EOF
set -e
sed -i 's/\r\$//' '$SBIN/hermes-swap-guard'
chmod 755 '$SBIN/hermes-swap-guard'
bash -n '$SBIN/hermes-swap-guard'

cat >/etc/systemd/system/hermes-swap-guard.service <<'UNIT'
[Unit]
Description=Reclaim swap held by retired nginx workers before earlyoom shoots hermes-webui
Documentation=man:journalctl(1)

[Service]
Type=oneshot
ExecStart=$SBIN/hermes-swap-guard
Environment=LOW_PCT=$LOW_PCT
Environment=MIN_INTERVAL=$MIN_INTERVAL
Environment=SHUTDOWN_GRACE=$SHUTDOWN_GRACE
Environment=DRY_RUN=$DRY_RUN
# Same reasoning as the db guards: on a box at ~200% memory overcommit, a
# guard must never be the allocation that trips the thing it guards against.
Nice=10
IOSchedulingClass=idle
MemoryHigh=64M
TimeoutStartSec=180
UNIT

cat >/etc/systemd/system/hermes-swap-guard.timer <<'UNIT'
[Unit]
Description=Check swap headroom every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=hermes-swap-guard.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-swap-guard.timer >/dev/null
echo '    timer enabled'
EOF

echo
echo "==> verify"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "
  systemctl list-timers hermes-swap-guard.timer --no-pager 2>/dev/null | head -3
  echo
  awk '/^SwapTotal:|^SwapFree:|^MemAvailable:/{print \"    \"\$0}' /proc/meminfo
"
echo
echo "done. watch it with:  journalctl -t hermes-swap-guard -f"

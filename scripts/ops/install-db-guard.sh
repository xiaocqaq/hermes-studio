#!/usr/bin/env bash
# install-db-guard.sh — install/refresh the state.db corruption guards on the
# hermes-web-ui server. Idempotent: safe to re-run, and MEANT to be re-run
# after every `npm i -g hermes-web-ui` upgrade.
#
# Why re-run after an upgrade: the VACUUM guard is a patch to
# hermes_state.py, a file owned by the hermes-agent package. An upgrade
# replaces that file wholesale and takes the patch with it. The daily sweep
# does re-apply it automatically (hermes-db-guard ensure-patch), but that
# leaves a window of up to one sweep interval; running this right after an
# upgrade closes it immediately.
#
# Background — the incident this exists to prevent (2026-08-27 → 08-29):
#   xiao/state.db auto-repair Strategy 2 dropped the FTS schema and ran
#   VACUUM while ~69 sibling processes still held the file open in WAL mode.
#   VACUUM shrank the file (21278 → ~15420 pages); the stale connections kept
#   emitting WAL frames carrying the pre-VACUUM db_size, whose b-tree cells
#   pointed at pages 15536..21278. Checkpointed, those became dangling
#   pointers in the main file, and every row written afterwards (id >= 8600)
#   landed in the dead zone. 1095 message rows were unrecoverable. Nobody
#   noticed for ~48h, until GET /api/hermes/sessions/hermes/groups 500'd.
#
# Usage:
#   ./install-db-guard.sh                      # install/refresh everything
#   DEPLOY_HOST=root@1.2.3.4 ./install-db-guard.sh
#   ./install-db-guard.sh --no-watchdog        # skip the self-stop watchdog
#   ./install-db-guard.sh --patch-only         # only re-apply the VACUUM guard
set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-root@115.159.206.76}
AGENT_DIR=${AGENT_DIR:-/usr/local/lib/hermes-agent}
SBIN=${SBIN:-/usr/local/sbin}
KEEP_DAYS=${KEEP_DAYS:-7}
WATCHDOG=1
PATCH_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-watchdog) WATCHDOG=0 ;;
    --patch-only)  PATCH_ONLY=1 ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")" && pwd)
for f in patch-vacuum-guard.py hermes-db-guard.sh hermes-webui-watchdog.sh; do
  [ -f "$HERE/$f" ] || { echo "missing $HERE/$f" >&2; exit 1; }
done

echo "==> target: $DEPLOY_HOST"

# ── 1. the VACUUM holder guard (root-cause patch) ──
echo "==> [1/4] VACUUM holder guard"
scp -q -o ConnectTimeout=20 "$HERE/patch-vacuum-guard.py" \
  "$DEPLOY_HOST:$AGENT_DIR/.patch-vacuum-guard.py"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "
  set -e
  sed -i 's/\r\$//' '$AGENT_DIR/.patch-vacuum-guard.py'
  python3 '$AGENT_DIR/.patch-vacuum-guard.py'
  grep -q HERMES_VACUUM_HOLDER_GUARD '$AGENT_DIR/hermes_state.py' \
    && echo '    guard: present' || { echo '    guard: MISSING'; exit 1; }
"

if [ "$PATCH_ONLY" = "1" ]; then
  echo "==> --patch-only: done"
  exit 0
fi

# ── 2. the guard script ──
echo "==> [2/4] hermes-db-guard"
scp -q -o ConnectTimeout=20 "$HERE/hermes-db-guard.sh" "$DEPLOY_HOST:$SBIN/hermes-db-guard"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "
  set -e
  sed -i 's/\r\$//' '$SBIN/hermes-db-guard'
  chmod 755 '$SBIN/hermes-db-guard'
  bash -n '$SBIN/hermes-db-guard' && echo '    syntax ok'
"

# ── 3. timers ──
# Two cadences: the 6-hourly check is read-only and cheap, and is what
# actually shrinks time-to-detection; the daily sweep is the one that costs
# disk, so it runs once. Both land off the hour, away from cron.daily and the
# aaPanel jobs.
echo "==> [3/4] systemd timers"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "bash -s" <<EOF
set -e
cat >/etc/systemd/system/hermes-db-guard.service <<'UNIT'
[Unit]
Description=Hermes SQLite integrity sweep + rolling backup
Documentation=file:/var/log/hermes-db-guard.log

[Service]
Type=oneshot
ExecStart=$SBIN/hermes-db-guard sweep
Environment=KEEP_DAYS=$KEEP_DAYS
# This box runs at ~250% memory overcommit with earlyoom active; a backup job
# must never be the thing that pushes it over.
Nice=15
IOSchedulingClass=idle
MemoryHigh=256M
TimeoutStartSec=1800
UNIT

cat >/etc/systemd/system/hermes-db-guard.timer <<'UNIT'
[Unit]
Description=Daily Hermes SQLite integrity sweep + backup

[Timer]
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=600
Persistent=true
Unit=hermes-db-guard.service

[Install]
WantedBy=timers.target
UNIT

cat >/etc/systemd/system/hermes-db-check.service <<'UNIT'
[Unit]
Description=Hermes SQLite integrity check (read-only, alerts only)

[Service]
Type=oneshot
ExecStart=$SBIN/hermes-db-guard check-alert
Nice=15
IOSchedulingClass=idle
MemoryHigh=128M
TimeoutStartSec=900
UNIT

cat >/etc/systemd/system/hermes-db-check.timer <<'UNIT'
[Unit]
Description=6-hourly Hermes SQLite integrity check

[Timer]
OnCalendar=*-*-* 01,07,13,19:43:00
RandomizedDelaySec=300
Persistent=true
Unit=hermes-db-check.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-db-guard.timer hermes-db-check.timer >/dev/null
echo "    db timers enabled"
EOF

# ── 4. self-stop watchdog ──
echo "==> [4/4] hermes-webui watchdog"
if [ "$WATCHDOG" = "0" ]; then
  echo "    skipped (--no-watchdog)"
else
  scp -q -o ConnectTimeout=20 "$HERE/hermes-webui-watchdog.sh" \
    "$DEPLOY_HOST:$SBIN/hermes-webui-watchdog"
  ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "bash -s" <<EOF
set -e
sed -i 's/\r\$//' '$SBIN/hermes-webui-watchdog'
chmod 755 '$SBIN/hermes-webui-watchdog'
bash -n '$SBIN/hermes-webui-watchdog'

cat >/etc/systemd/system/hermes-webui-watchdog.service <<'UNIT'
[Unit]
Description=Restart hermes-webui after an unintended stop
Documentation=man:journalctl(1)

[Service]
Type=oneshot
ExecStart=$SBIN/hermes-webui-watchdog
Nice=10
TimeoutStartSec=120
UNIT

cat >/etc/systemd/system/hermes-webui-watchdog.timer <<'UNIT'
[Unit]
Description=Check hermes-webui liveness every 2 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=30s
Unit=hermes-webui-watchdog.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now hermes-webui-watchdog.timer >/dev/null
echo "    watchdog enabled"
EOF
fi

echo
echo "==> verify"
ssh -o ConnectTimeout=20 "$DEPLOY_HOST" "
  systemctl list-timers 'hermes-*' --no-pager 2>/dev/null | head -5
  echo
  $SBIN/hermes-db-guard check
"
echo
echo "done. review alerts with:  journalctl -t hermes-db-guard -p err"

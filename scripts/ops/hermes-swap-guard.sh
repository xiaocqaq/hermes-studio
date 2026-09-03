#!/usr/bin/env bash
# hermes-swap-guard — keep enough swap free that earlyoom never has to shoot
# hermes-webui.
#
# The incident this exists to prevent (2026-09-02, 09:27 → 10:18):
#   hermes-webui looked like it was crash-looping — 12 restarts in 10 minutes,
#   every request 502. It was not crashing: systemd logged "Deactivated
#   successfully" (exit 0) and the app log only ever showed
#   "[shutdown] Received signal: SIGTERM". earlyoom was killing it.
#
#   earlyoom (-m 18,9 -s 25,12) only fires when memory AND swap are both under
#   their thresholds. Swap had been pinned under 25% free for hours because five
#   openresty/BT-WAF workers were sitting on 1.02 GB of it (one worker alone held
#   615 MB) and earlyoom's --avoid list contains nginx, so that swap was never
#   reclaimed. With the swap half of the AND permanently satisfied, the only
#   remaining gate was "available memory < 18%" — and hermes-webui's own boot
#   burst (9 profile gateways, ~2.1 GB within 50 s) crosses that gate every
#   single time. Restart=always then replayed the burst, forever.
#
#   `nginx -s reload` fixed it: retiring the bloated workers took swap free from
#   13.7% to 47.6% and the loop stopped instantly.
#
# Two things make this recur on its own:
#   1. those workers grow ~1 GB of anonymous memory in under two hours, and
#   2. nginx.conf sets no worker_shutdown_timeout, so a worker retired by a
#      reload keeps running — and keeps holding its swap — until every one of
#      its connections closes. socket.io websockets kept one alive for 2h36m
#      after the reload, still holding 289 MB of swap.
#
# So this guard reloads nginx when swap gets low, and — only when swap is low
# and only after a long grace period — terminates workers that are still
# "shutting down". Terminating one drops the websockets it holds; socket.io
# reconnects automatically, which is far cheaper than the restart loop above.
#
# Install with install-swap-guard.sh. Runs from a timer; does nothing on a
# healthy box.
set -uo pipefail

TAG=hermes-swap-guard
LOW_PCT=${LOW_PCT:-30}              # act when SwapFree/SwapTotal drops below this
MIN_INTERVAL=${MIN_INTERVAL:-1800}  # seconds between reloads
SHUTDOWN_GRACE=${SHUTDOWN_GRACE:-600}
STAMP=/run/hermes-swap-guard.last-reload
DRY_RUN=${DRY_RUN:-0}

log()  { logger -t "$TAG" -p daemon.info -- "$1" 2>/dev/null; }
warn() { logger -t "$TAG" -p daemon.warning -- "$1" 2>/dev/null; }
err()  { logger -t "$TAG" -p daemon.err -- "$1" 2>/dev/null; }

swap_total=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)

# No swap configured means no swap half of earlyoom's AND to worry about.
[ "${swap_total:-0}" -gt 0 ] || exit 0

swap_pct=$(( swap_free * 100 / swap_total ))
mem_pct=$(( mem_avail * 100 / mem_total ))

if [ "$swap_pct" -ge "$LOW_PCT" ]; then
  exit 0
fi

# Name the holders in the log before touching anything: if it is not nginx this
# time, the log is the only record of who it actually was.
holders=$(
  for p in /proc/[0-9]*; do
    s=$(awk '/^VmSwap:/{print $2}' "$p/status" 2>/dev/null) || continue
    [ -n "$s" ] && [ "$s" -gt 20480 ] && echo "$s $(cat "$p/comm" 2>/dev/null)/${p#/proc/}"
  done | sort -rn | head -5 | awk '{printf "%s(%dM) ", $2, $1/1024}'
)
warn "swap free ${swap_pct}% (< ${LOW_PCT}%), mem available ${mem_pct}% — top swap holders: ${holders:-none}"

if ! pgrep -f 'nginx: worker process' >/dev/null 2>&1; then
  warn "no nginx workers present — nothing this guard can reclaim, leaving it to earlyoom"
  exit 0
fi

now=$(date +%s)
last=$(cat "$STAMP" 2>/dev/null || echo 0)
case "$last" in ''|*[!0-9]*) last=0 ;; esac

if [ $((now - last)) -lt "$MIN_INTERVAL" ]; then
  log "reloaded $((now - last))s ago (min ${MIN_INTERVAL}s) — not reloading again"
else
  if [ "$DRY_RUN" = "1" ]; then
    warn "DRY_RUN: would reload nginx now"
  else
    warn "reloading nginx to retire workers holding swap"
    if [ -x /etc/init.d/nginx ]; then
      /etc/init.d/nginx reload >/dev/null 2>&1 || err "nginx reload FAILED"
    elif command -v nginx >/dev/null 2>&1; then
      nginx -s reload >/dev/null 2>&1 || err "nginx -s reload FAILED"
    else
      err "no way to reload nginx found"
    fi
    echo "$now" >"$STAMP"
    sleep 15
    new_pct=$(( $(awk '/^SwapFree:/{print $2}' /proc/meminfo) * 100 / swap_total ))
    log "swap free after reload: ${new_pct}%"
  fi
fi

# A retired worker that is still "shutting down" long after the reload is
# waiting on connections that may never close, and it is sitting on the swap we
# came here for. Only reached while swap is still below LOW_PCT.
swap_free=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)
swap_pct=$(( swap_free * 100 / swap_total ))
[ "$swap_pct" -lt "$LOW_PCT" ] || exit 0

# $3 must literally be "nginx:" — without that guard, ps also lists this very
# awk process, whose own command line contains the pattern being searched for.
ps -eo pid=,etimes=,args= |
  awk '$3 == "nginx:" && $0 ~ /worker process is shutting down/ {print $1" "$2}' |
while read -r pid age; do
  [ -n "${pid:-}" ] || continue
  [ "${age:-0}" -ge "$SHUTDOWN_GRACE" ] || continue
  held=$(awk '/^VmSwap:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
  if [ "$DRY_RUN" = "1" ]; then
    warn "DRY_RUN: would SIGTERM retired nginx worker $pid (draining ${age}s, holds $((held / 1024))M swap)"
    continue
  fi
  warn "SIGTERM retired nginx worker $pid — draining ${age}s (grace ${SHUTDOWN_GRACE}s), holds $((held / 1024))M swap; its websockets will reconnect"
  kill -TERM "$pid" 2>/dev/null || err "failed to signal nginx worker $pid"
done

sleep 2
final=$(( $(awk '/^SwapFree:/{print $2}' /proc/meminfo) * 100 / swap_total ))
if [ "$final" -lt 15 ]; then
  err "swap free still ${final}% after reclaim attempt — earlyoom may shoot hermes-webui; investigate the holders logged above"
else
  log "swap free now ${final}%"
fi

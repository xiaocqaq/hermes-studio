#!/usr/bin/env bash
# hermes-webui-watchdog — bring hermes-webui back after an unintended stop.
#
# 2026-08-29 12:17:51: an agent session running INSIDE hermes-webui's own cgroup
# executed `systemctl stop hermes-webui`. KillMode=mixed then SIGKILLed the whole
# cgroup — including the bash+systemctl that issued the command (PIDs 3584807 /
# 3584809 in the journal), so a `restart`'s start half never ran. Restart=always
# does not cover an explicit stop, so the unit stayed dead for 3h31m unnoticed.
#
# Distinguishing "operator meant it" from "the service shot itself" cannot be
# done from the stop event alone, so this uses intent that outlives the process:
#
#   systemctl disable hermes-webui   -> watchdog stands down (is-enabled != enabled)
#   touch /run/hermes-webui.admin-stop -> stands down until next boot
#   touch /etc/hermes-webui.admin-stop -> stands down permanently
#
# Anything else that leaves an enabled unit inactive is treated as the failure
# mode above and restarted.
set -uo pipefail

UNIT=hermes-webui
TAG=hermes-webui-watchdog
FLAG=/run/hermes-webui-watchdog.seen-inactive

log()  { logger -t "$TAG" -p daemon.info -- "$1" 2>/dev/null; }
warn() { logger -t "$TAG" -p daemon.warning -- "$1" 2>/dev/null; }

for m in /run/hermes-webui.admin-stop /etc/hermes-webui.admin-stop; do
  if [ -e "$m" ]; then
    rm -f "$FLAG"
    exit 0   # operator asked for it; say nothing, every tick
  fi
done

# A masked or disabled unit is an explicit operator decision. is-enabled prints
# enabled / disabled / masked / static and exits non-zero for most non-enabled
# states, so capture the word rather than the exit code.
state=$(systemctl is-enabled "$UNIT" 2>/dev/null || true)
if [ "$state" != "enabled" ]; then
  rm -f "$FLAG"
  exit 0
fi

if systemctl is-active --quiet "$UNIT"; then
  rm -f "$FLAG"
  exit 0
fi

# Require two consecutive inactive ticks before acting. A single tick can land
# inside a legitimate restart (npm upgrade, deploy) and racing that would fight
# the operator; the unit is only down ~10s there, so it never sees tick two.
if [ ! -e "$FLAG" ]; then
  : >"$FLAG"
  warn "$UNIT is enabled but inactive — will restart if still down at next check"
  exit 0
fi

rm -f "$FLAG"
warn "$UNIT enabled but inactive for two consecutive checks — starting it"
if systemctl start "$UNIT"; then
  sleep 5
  if systemctl is-active --quiet "$UNIT"; then
    warn "$UNIT restarted by watchdog (was stopped without operator intent)"
  else
    logger -t "$TAG" -p daemon.err -- "$UNIT start returned 0 but unit is not active" 2>/dev/null
  fi
else
  logger -t "$TAG" -p daemon.err -- "$UNIT start FAILED — manual attention needed" 2>/dev/null
fi

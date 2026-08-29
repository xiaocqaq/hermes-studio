#!/usr/bin/env bash
# hermes-db-guard — daily integrity sweep + rolling backups for hermes SQLite DBs.
#
# Why this exists: xiao/state.db was silently corrupt from 2026-08-27 until a
# user-visible 500 on 2026-08-29. Two days of writes landed in a dead b-tree
# region and 1095 message rows became unrecoverable. Detection, not repair, is
# what was missing — a daily quick_check would have caught it the same morning,
# while a same-day backup still held the rows.
#
# Deliberately NOT automatic: restoring a backup over a live DB. A corrupt DB
# is a broken endpoint, but silently swapping in a backup up to 24h old is
# data loss chosen by a cron job. The sweep reports; a human runs `restore`.
#
# Subcommands:
#   sweep         check every DB, back up the healthy ones, prune, verify patch
#   check         check only, no writes
#   restore DB    restore DB from its newest healthy backup (asks nothing —
#                 run it deliberately; the current file is kept aside)
#   ensure-patch  re-apply the VACUUM holder guard if an upgrade removed it
set -uo pipefail   # no -e: one unreadable DB must not abort the whole sweep

BACKUP_ROOT=${BACKUP_ROOT:-/root/hermes-db-backups}
KEEP_DAYS=${KEEP_DAYS:-7}
LOG=${LOG:-/var/log/hermes-db-guard.log}
STATE_PY=/usr/local/lib/hermes-agent/hermes_state.py
PATCH_PY=/usr/local/lib/hermes-agent/.patch-vacuum-guard.py
MARKER=HERMES_VACUUM_HOLDER_GUARD
TAG=hermes-db-guard

log() {
  printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  # journal too, so `journalctl -t hermes-db-guard` is enough to review history
  command -v logger >/dev/null 2>&1 && logger -t "$TAG" -p "${2:-daemon.info}" -- "$1" 2>/dev/null
}
err() { log "$1" daemon.err; }

list_dbs() {
  local d
  for d in /root/.hermes/state.db /root/.hermes/profiles/*/state.db \
           /root/.hermes-web-ui/hermes-web-ui.db /root/.hermes/kanban.db; do
    [ -f "$d" ] && printf '%s\n' "$d"
  done
}

# /root/.hermes/profiles/xiao/state.db -> hermes_profiles_xiao_state.db
slug() { printf '%s' "${1#/root/.}" | tr '/' '_'; }

check_db() {
  # quick_check is the cheap variant: it skips the UNIQUE/NOT NULL and
  # orphan-page passes that made the full integrity_check take minutes on a
  # 70MB file, but still walks every b-tree — which is where this class of
  # damage lives.
  timeout 600 sqlite3 "$1" 'PRAGMA quick_check(1);' 2>&1 | head -1
}

backup_db() {
  local db=$1 dest="$BACKUP_ROOT/$(slug "$1")"
  mkdir -p "$dest" || return 1
  local out="$dest/$(date '+%Y%m%d-%H%M%S').db"
  # sqlite3 .backup, not cp: it takes a read lock and produces a consistent
  # snapshot of a database that is being written to. A raw cp of a live WAL
  # database yields a torn file — which is how you end up with a backup that
  # is itself corrupt, i.e. no backup at all.
  if ! timeout 900 sqlite3 "$db" ".backup '$out'" 2>>"$LOG"; then
    err "backup FAILED: $db"; rm -f "$out"; return 1
  fi
  # Verify the copy before trusting it. An unverified backup is a guess.
  if [ "$(check_db "$out")" != "ok" ]; then
    err "backup verify FAILED (discarded): $out"; rm -f "$out"; return 1
  fi
  gzip -f "$out" 2>>"$LOG" || true
  log "backup ok: ${out}.gz ($(du -h "${out}.gz" 2>/dev/null | cut -f1))"
}

prune() {
  # -mtime +N, not `ls | head -n -K`: retention here is "how far back can I
  # restore", which is a question about time, not about file count.
  find "$BACKUP_ROOT" -type f -name '*.db.gz' -mtime "+$KEEP_DAYS" -print -delete 2>/dev/null |
    while read -r old; do log "pruned: $old"; done
}

ensure_patch() {
  [ -f "$STATE_PY" ] || return 0
  if grep -q "$MARKER" "$STATE_PY" 2>/dev/null; then
    return 0
  fi
  # npm/pip upgrades replace hermes_state.py wholesale, taking the guard with
  # it. Re-applying here means an upgrade leaves the box unguarded for at most
  # one sweep interval instead of forever.
  err "VACUUM holder guard MISSING from $STATE_PY (upgrade overwrote it) — re-applying"
  if [ -x "$PATCH_PY" ] || [ -f "$PATCH_PY" ]; then
    if python3 "$PATCH_PY" >>"$LOG" 2>&1; then
      log "VACUUM holder guard re-applied"
    else
      err "re-apply FAILED — auto-repair VACUUM is UNGUARDED, see $LOG"
    fi
  else
    err "patch script $PATCH_PY missing — cannot re-apply guard"
  fi
}

do_restore() {
  local db=$1 dest="$BACKUP_ROOT/$(slug "$1")"
  local newest
  newest=$(ls -1t "$dest"/*.db.gz 2>/dev/null | head -1)
  [ -n "$newest" ] || { err "restore: no backup for $db"; return 1; }
  if [ "$(count_holders "$db")" -gt 0 ]; then
    err "restore: $db is open by another process — stop the service first"
    return 1
  fi
  local ts; ts=$(date '+%Y%m%d-%H%M%S')
  local tmp="${db}.restore-$ts"
  gzip -dc "$newest" >"$tmp" || { err "restore: gunzip failed"; rm -f "$tmp"; return 1; }
  [ "$(check_db "$tmp")" = "ok" ] || { err "restore: backup not clean, aborting"; rm -f "$tmp"; return 1; }
  # Move the stale -wal/-shm aside as well: left in place, SQLite replays them
  # onto the restored file and re-injects the damage they carry.
  mv "$db" "${db}.replaced-$ts" && log "restore: current -> ${db}.replaced-$ts"
  [ -f "${db}-wal" ] && mv "${db}-wal" "${db}-wal.replaced-$ts"
  rm -f "${db}-shm"
  mv "$tmp" "$db" || { err "restore: final mv failed"; return 1; }
  chown root:root "$db"; chmod 644 "$db"
  log "restore: $db <- $newest"
}

count_holders() {
  local target n=0 p t
  target=$(readlink -f "$1" 2>/dev/null) || return 0
  for p in /proc/[0-9]*/fd/*; do
    t=$(readlink "$p" 2>/dev/null) || continue
    [ "$t" = "$target" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

cmd_sweep() {
  local bad=0 total=0 res
  ensure_patch
  while read -r db; do
    total=$((total + 1))
    res=$(check_db "$db")
    if [ "$res" = "ok" ]; then
      backup_db "$db"
    else
      bad=$((bad + 1))
      err "CORRUPT: $db -> $res"
      err "  restore with: $0 restore $db   (stop hermes-webui first)"
    fi
  done < <(list_dbs)
  prune
  if [ "$bad" -gt 0 ]; then
    err "sweep done: $bad of $total DBs CORRUPT"
    return 1
  fi
  log "sweep done: $total/$total healthy, backups in $BACKUP_ROOT"
}

cmd_check_alert() {
  # Read-only counterpart of sweep, for the 6-hourly cadence: catches damage
  # within hours without paying 62MB of backup disk four times a day.
  local bad=0 total=0 res
  while read -r db; do
    total=$((total + 1))
    res=$(check_db "$db")
    if [ "$res" != "ok" ]; then
      bad=$((bad + 1))
      err "CORRUPT: $db -> $res"
      err "  newest backup: $(ls -1t "$BACKUP_ROOT/$(slug "$db")"/*.db.gz 2>/dev/null | head -1)"
      err "  restore with: systemctl stop hermes-webui && $0 restore $db"
    fi
  done < <(list_dbs)
  if [ "$bad" -gt 0 ]; then
    err "check done: $bad of $total DBs CORRUPT"
    return 1
  fi
  log "check done: $total/$total healthy"
}

case "${1:-sweep}" in
  sweep)        cmd_sweep ;;
  check-alert)  cmd_check_alert ;;
  check)        while read -r db; do printf '%-46s %s\n' "${db#/root/}" "$(check_db "$db")"; done < <(list_dbs) ;;
  restore)      [ $# -ge 2 ] || { echo "usage: $0 restore /path/to/state.db" >&2; exit 2; }; do_restore "$2" ;;
  ensure-patch) ensure_patch; grep -q "$MARKER" "$STATE_PY" && echo "guard: present" || echo "guard: MISSING" ;;
  *)            echo "usage: $0 {sweep|check|restore DB|ensure-patch}" >&2; exit 2 ;;
esac

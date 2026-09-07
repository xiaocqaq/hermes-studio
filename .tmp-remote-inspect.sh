#!/usr/bin/env bash
CFG=/root/.hermes-web-ui/.ekko/config/config.json
echo '=== ekko tools config ==='
python3 - "$CFG" <<'PY'
import json,sys
cfg=json.load(open(sys.argv[1]))
tools=cfg.get('tools',{})
print('executionTimeoutMs:', tools.get('executionTimeoutMs'))
print('codeExec.timeoutMs:', tools.get('codeExec',{}).get('timeoutMs'))
print('approvals.timeoutMs:', tools.get('approvals',{}).get('timeoutMs'))
print('model.requestTimeoutMs:', cfg.get('model',{}).get('requestTimeoutMs'))
print('schemaVersion:', cfg.get('schemaVersion'))
PY
echo '=== auxiliary image settings per profile ==='
for d in /root/.hermes-web-ui/profiles/*/; do
  p=$(basename "$d")
  if [ -f "$d/config.yaml" ]; then
    aux=$(grep -A8 '^auxiliary:' "$d/config.yaml" 2>/dev/null | grep -E 'image_generation|image_edit|timeout|model:|provider:' | tr '\n' '|')
    [ -n "$aux" ] && echo "$p => $aux"
  fi
done
echo '=== fun-codex provider present? ==='
grep -l 'fun-codex' /root/.hermes-web-ui/profiles/*/config.yaml 2>/dev/null | head -10
echo '=== db-guard state ==='
grep -c HERMES_VACUUM_HOLDER_GUARD /usr/local/lib/hermes-agent/hermes_state.py 2>/dev/null || echo 'guard-missing-or-no-file'
systemctl list-timers 'hermes-*' --no-pager 2>/dev/null | head -6
echo '=== ekko logs location ==='
ls -1 /root/.hermes-web-ui/.ekko 2>/dev/null
find /root/.hermes-web-ui/.ekko -maxdepth 3 -name '*.log' 2>/dev/null | head -5
echo '=== timeout evidence in ekko logs ==='
for f in $(find /root/.hermes-web-ui/.ekko -maxdepth 3 -name '*.log' 2>/dev/null | head -6); do
  c=$(grep -c 'timed out after 120000ms' "$f" 2>/dev/null || echo 0)
  echo "$f: $c"
done
echo '=== studio-image-gen invocations in ekko logs ==='
for f in $(find /root/.hermes-web-ui/.ekko -maxdepth 3 -name '*.log' 2>/dev/null | head -6); do
  c=$(grep -c 'studio-image-gen' "$f" 2>/dev/null || echo 0)
  [ "$c" != "0" ] && echo "$f: $c"
done
echo '=== current frontend release ==='
grep -oP '(?<=root )\S+(?=;)' /www/server/panel/vhost/nginx/hs.xlingo.fun.conf 2>/dev/null | head -3
ls -1dt /www/wwwroot/hs.xlingo.fun/releases/*-frontend 2>/dev/null | head -5
echo '=== nginx api timeouts ==='
grep -nE 'proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' /www/server/panel/vhost/nginx/hs.xlingo.fun.conf 2>/dev/null | head -10
echo '=== disk ==='
df -h / /www 2>/dev/null | head -4

#!/bin/sh
# Keep POST /api/studio/update behind the super-admin guard.
#
# Background (2026-10-03): the 0.7.28 dist shipped that route with NO auth
# middleware --
#   Xu.post("/api/studio/update",Xye);
# while all six sibling preview routes carried JR (requireSuperAdmin):
#   Xu.get("/api/studio/update/preview",JR,Hye); ...
# Any logged-in user (role=user included) could therefore trigger
# `npm install -g ... @latest` plus a service restart. That is exactly how the
# production install was upgraded in place at 10:08 that day.
#
# Upstream fixed the route in source, and this fork now also guards it in
# source (packages/server/src/modules/studio/routes/update.ts), so a build from
# this repository already contains the guard. This script stays as a safety net
# for the case where dist/server/index.js gets replaced by a plain npm package
# build that lost the guard.
#
# IMPORTANT: never hardcode the minified identifiers. They change on every
# rebuild (`Xye`/`JR` became `rje`/`JH` and then `rje`/`Zw`), which is why the
# first version of this script silently failed with "expected pattern not
# found" on every boot after the fork's own dist was overlaid. Instead, read
# the guard identifier off a sibling preview route in the same bundle: every
# preview route is guarded, so its first middleware IS requireSuperAdmin.
set -eu
D=/usr/lib/node_modules/hermes-web-ui/dist/server/index.js

[ -f "$D" ] || { echo "ERROR: $D not found" >&2; exit 1; }

python3 - "$D" <<'PY'
import re
import shutil
import sys
import time

path = sys.argv[1]
src = open(path, encoding='utf-8').read()

TARGET = '.post("/api/studio/update",'
PREVIEW = '.get("/api/studio/update/preview",'

# The guard is the first middleware of every preview route; take the token
# between the route path and the controller, e.g.
#   .get("/api/studio/update/preview",Zw,nje)  ->  Zw
preview = re.search(re.escape(PREVIEW) + r'([A-Za-z_$][\w$]*)\s*,', src)
if not preview:
    sys.exit('ERROR: cannot locate a guarded preview route; dist layout changed, '
             'check %s by hand' % path)
guard = preview.group(1)

target_hits = [m.start() for m in re.finditer(re.escape(TARGET), src)]
if len(target_hits) != 1:
    sys.exit('ERROR: expected exactly 1 %s, found %d' % (TARGET, len(target_hits)))

after = src[target_hits[0] + len(TARGET):]
if re.match(re.escape(guard) + r'\s*,', after):
    print('already guarded (%s)' % guard)
    sys.exit(0)

# Guard present but pointing at a different symbol is also fine -- it means the
# route already runs through some middleware. Only an immediately-closed call
# (handler then `)`) is unguarded.
handler = re.match(r'([A-Za-z_$][\w$]*)\s*\)', after)
if not handler:
    print('already guarded by another middleware')
    sys.exit(0)

old = TARGET + handler.group(1) + ')'
new = TARGET + guard + ',' + handler.group(1) + ')'
assert src.count(old) == 1, 'unexpected duplicate target'

ts = time.strftime('%Y%m%d-%H%M%S')
bak = '%s.bak.%s' % (path, ts)
shutil.copy2(path, bak)
print('backup: %s' % bak)

open(path, 'w', encoding='utf-8').write(src.replace(old, new, 1))
print('patched: %s -> %s' % (old, new))
PY

node --check "$D"
echo "syntax OK"

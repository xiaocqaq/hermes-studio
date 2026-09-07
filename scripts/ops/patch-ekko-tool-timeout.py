#!/usr/bin/env python3
import os, shutil, sys, time
DIST = os.environ.get('HERMES_WEBUI_SERVER_BUNDLE', '/usr/lib/node_modules/hermes-web-ui/dist/server/index.js')
MARKER = 'EKKO_TOOL_TIMEOUT_MS'
OLD = ('mcpServers:se,timeoutMs:12e4,signal:', 'mcpServers:se,timeoutMs:120000,signal:')
NEW = 'mcpServers:se,timeoutMs:Number(process.env.EKKO_TOOL_TIMEOUT_MS)||6e5,signal:'
if not os.path.isfile(DIST):
    print(f'ABORT: bundle not found: {DIST}'); sys.exit(1)
src = open(DIST, encoding='utf-8').read()
if MARKER in src:
    print('ALREADY PATCHED - no change'); sys.exit(0)
hits = [x for x in OLD if x in src]
if len(hits) != 1:
    print(f'ABORT: expected exactly one target shape, found {len(hits)}'); sys.exit(1)
ts = time.strftime('%Y%m%d-%H%M%S')
bak = f'{DIST}.bak.{ts}'
shutil.copy2(DIST, bak)
patched = src.replace(hits[0], NEW, 1)
open(DIST, 'w', encoding='utf-8').write(patched)
if patched.count(NEW) != 1:
    shutil.copy2(bak, DIST); print('ABORT: verification failed; restored backup'); sys.exit(1)
print(f'backup: {bak}')
print('PATCHED OK; default timeout is 600000ms')
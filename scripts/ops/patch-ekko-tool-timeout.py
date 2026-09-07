#!/usr/bin/env python3
"""Patch the packaged Ekko chat tool timeout after hermes-web-ui upgrades.

The upstream bundle hardcodes `timeoutMs:12e4` (120s) in the Ekko chat tool
context, which SIGTERMs long-running image-generation skills (gpt-image-2)
before their own 10-minute request timeout. Only the context shape with
`mcpServers` + `timeoutMs` + `signal` is changed; the group-chat bridge
timeout (also `12e4`, but no `mcpServers` prefix) is left alone. Idempotent.
"""
import os
import re
import shutil
import sys
import time

DIST = os.environ.get("HERMES_WEBUI_SERVER_BUNDLE", "/usr/lib/node_modules/hermes-web-ui/dist/server/index.js")
MARKER = "EKKO_TOOL_TIMEOUT_MS"
# toolContext:  ...,mcpServers:<ident>,timeoutMs:120000,signal:...
PATTERN = re.compile(r"(mcpServers:[A-Za-z_$][\w$]*,timeoutMs:)(1[02]e[45]|120000|12e4)(,signal:)", re.ASCII)
REPLACEMENT = r"\g<1>Number(process.env.EKKO_TOOL_TIMEOUT_MS)||6e5\g<3>"

if not os.path.isfile(DIST):
    print(f"ABORT: bundle not found: {DIST}")
    sys.exit(1)

src = open(DIST, encoding="utf-8").read()
if MARKER in src:
    print("ALREADY PATCHED - no change")
    sys.exit(0)

matches = PATTERN.findall(src)
if len(matches) != 1:
    print(f"ABORT: expected exactly one tool-context shape, found {len(matches)}")
    sys.exit(1)

ts = time.strftime("%Y%m%d-%H%M%S")
bak = f"{DIST}.bak.{ts}"
shutil.copy2(DIST, bak)
patched = PATTERN.sub(REPLACEMENT, src, count=1)
open(DIST, "w", encoding="utf-8").write(patched)

if MARKER not in patched or patched.count(MARKER) != 1:
    shutil.copy2(bak, DIST)
    print("ABORT: verification failed; restored backup")
    sys.exit(1)

print(f"backup: {bak}")
print("PATCHED OK; default timeout is 600000ms (override: EKKO_TOOL_TIMEOUT_MS)")
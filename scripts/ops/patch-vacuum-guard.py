#!/usr/bin/env python3
"""Gate the auto-repair VACUUM behind a live-holder check.

Root cause of the 2026-08-27 / 08-29 xiao/state.db corruption: repair
Strategy 2 dropped the FTS schema and ran VACUUM while ~69 sibling
processes (gateway / bridge / cron) still held the same file open in WAL
mode. VACUUM rewrote and shrank the file (21278 -> ~15420 pages); the old
connections kept writing WAL frames carrying the pre-VACUUM db_size, whose
b-tree cells referenced pages 15536..21278. Once checkpointed, the main
file's b-tree held pointers past its own end, and every row written after
the repair (id >= 8600) landed in that dead zone.

The module already ships count_db_holders() for exactly this question but
never calls it. This patch wires it in. Idempotent: re-running is a no-op.
"""
import py_compile
import shutil
import sys
import time

F = "/usr/local/lib/hermes-agent/hermes_state.py"
MARKER = "HERMES_VACUUM_HOLDER_GUARD"

OLD = '            conn.commit()\n            conn.execute("VACUUM")\n'

NEW = '''            conn.commit()
            # ── {marker}: never VACUUM a live database ──
            # VACUUM rewrites and SHRINKS the file. Sibling processes
            # (gateway / bridge / cron / web_server) that still hold this
            # path open in WAL mode keep their pre-VACUUM page map, and
            # their next writes emit WAL frames whose b-tree cells point at
            # pages beyond the shrunken file's end. Checkpointing those
            # frames bakes dangling pointers into the main file -- the exact
            # corruption this repair is supposed to fix.
            #
            # Dropping the FTS schema above is what actually clears the
            # malformed state; VACUUM is only space reclamation. Skipping it
            # leaves free pages behind (harmless, reclaimed by a later
            # offline VACUUM) instead of risking the file.
            _holders = count_db_holders(db_path)
            if _holders is not None and _holders > 1:
                logger.error(
                    "state.db repair: %d processes still hold %s open -- "
                    "skipping VACUUM to avoid shrinking the file under them "
                    "(FTS schema was dropped, which is the actual repair). "
                    "Run an offline VACUUM during a maintenance window to "
                    "reclaim space.",
                    _holders, db_path,
                )
            else:
                conn.execute("VACUUM")
'''.format(marker=MARKER)

src = open(F, encoding="utf-8").read()

if MARKER in src:
    print("ALREADY PATCHED — no change")
    sys.exit(0)

n = src.count(OLD)
if n != 1:
    print("ABORT: target text found %d times (expected exactly 1)" % n)
    sys.exit(1)

if "def count_db_holders" not in src:
    print("ABORT: count_db_holders() not present in this build")
    sys.exit(1)

ts = time.strftime("%Y%m%d-%H%M%S")
bak = "%s.bak.%s" % (F, ts)
shutil.copy2(F, bak)
print("backup: %s" % bak)

open(F, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))

try:
    py_compile.compile(F, doraise=True)
    print("py_compile: OK")
except py_compile.PyCompileError as exc:
    shutil.copy2(bak, F)
    print("SYNTAX ERROR — reverted from backup:\n%s" % exc)
    sys.exit(1)

print("PATCHED OK")

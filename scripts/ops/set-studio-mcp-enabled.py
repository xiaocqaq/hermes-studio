#!/usr/bin/env python3
"""set-studio-mcp-enabled.py — flip `enabled` on a bundled Studio MCP server in
every Hermes profile, without reformatting the YAML.

Why this exists (2026-09-02): a 3.7 GB box was running 80 `hermes-studio-mcp.mjs`
node processes — the four bundled servers (api / browser / devices / use) times
nine profiles, times two independent owners (each profile gateway spawns a set,
and each agent-bridge profile worker spawns another set at startup). That, plus
41 `mcp_stdio_watchdog.py`, was the bulk of a 1.97 GB cgroup and left so little
headroom that earlyoom SIGTERMed hermes-webui on every boot burst.

On a headless Linux server the `browser` toolset exposes zero tools: it is an
HTTP client for the Electron Desktop browser broker (bin/hermes-studio-mcp.mjs
browserDescriptor()), which does not exist there. Disabling it removes 20 node
processes and 20 watchdogs at zero functional cost.

Two things to know before running this:

  * hermes-web-ui's auto-injector preserves a user `enabled: false`
    (packages/server/src/modules/hermes/services/mcp/studio-autoinject.ts), and
    the Hermes bridge honours it (bridge_runtime.py) — so the change survives.
  * BUT that same code returns early for the whole profile as soon as any one of
    the four entries is disabled, so the other three stop being re-synced for
    that profile. After `npm i -g hermes-web-ui`, re-run this script and check
    the remaining entries still point at the new install path.

Usage:
  set-studio-mcp-enabled.py hermes-studio-browser false
  set-studio-mcp-enabled.py hermes-studio-browser true
  set-studio-mcp-enabled.py hermes-studio-browser false --dry-run
  set-studio-mcp-enabled.py hermes-studio-devices false --home /root/.hermes

Restart hermes-webui afterwards for it to take effect.
"""
from __future__ import annotations

import argparse
import glob
import os
import shutil
import sys
import time

TRUTHY = {"true", "1", "yes", "on"}
FALSY = {"false", "0", "no", "off"}


def indent_of(line: str) -> int:
    stripped = line.lstrip(" ")
    return len(line) - len(stripped)


def find_block(lines: list[str], start: int, own_indent: int, limit: int) -> int:
    """Index one past the last line belonging to the block opened at `start`."""
    end = start + 1
    while end < limit:
        line = lines[end]
        if line.strip() and indent_of(line) <= own_indent:
            break
        end += 1
    return end


def patch_file(path: str, server: str, value: str, dry_run: bool) -> str:
    with open(path, "r", encoding="utf-8", newline="") as fh:
        lines = fh.readlines()

    root = None
    for i, line in enumerate(lines):
        if indent_of(line) == 0 and line.split("#", 1)[0].strip() == "mcp_servers:":
            root = i
            break
    if root is None:
        return "no mcp_servers block"

    root_end = find_block(lines, root, 0, len(lines))

    target = None
    for i in range(root + 1, root_end):
        line = lines[i]
        if line.strip() == f"{server}:":
            target = i
            break
    if target is None:
        return f"no {server} entry"

    key_indent = indent_of(lines[target])
    field_indent = key_indent + 2
    entry_end = find_block(lines, target, key_indent, root_end)
    newline = "\r\n" if lines[target].endswith("\r\n") else "\n"

    for i in range(target + 1, entry_end):
        line = lines[i]
        if indent_of(line) != field_indent:
            continue
        head, _, tail = line.partition(":")
        if head.strip() != "enabled":
            continue
        current = tail.split("#", 1)[0].strip()
        if current == value:
            return f"already {value}"
        lines[i] = f"{' ' * field_indent}enabled: {value}{newline}"
        break
    else:
        lines.insert(entry_end, f"{' ' * field_indent}enabled: {value}{newline}")

    if dry_run:
        return f"would set {value}"

    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="") as fh:
        fh.writelines(lines)
    shutil.copystat(path, tmp)
    os.replace(tmp, path)
    return f"set {value} (backup: {os.path.basename(backup)})"


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True, description=__doc__)
    parser.add_argument("server", help="MCP server name, e.g. hermes-studio-browser")
    parser.add_argument("value", help="true or false")
    parser.add_argument("--home", default=os.path.expanduser("~/.hermes"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    lowered = args.value.strip().lower()
    if lowered in TRUTHY:
        value = "true"
    elif lowered in FALSY:
        value = "false"
    else:
        print(f"value must be true or false, got {args.value!r}", file=sys.stderr)
        return 2

    # The 'default' profile lives at the Hermes home root; named profiles live
    # under profiles/<name>/ (profile.ts listProfileNamesFromDisk).
    targets = [os.path.join(args.home, "config.yaml")]
    targets += sorted(glob.glob(os.path.join(args.home, "profiles", "*", "config.yaml")))
    targets = [p for p in targets if os.path.isfile(p)]
    if not targets:
        print(f"no config.yaml found under {args.home}", file=sys.stderr)
        return 1

    changed = failed = 0
    for path in targets:
        try:
            result = patch_file(path, args.server, value, args.dry_run)
        except OSError as exc:
            result = f"ERROR: {exc}"
        if result.startswith(("set ", "would set ")):
            changed += 1
        elif result.startswith(("no ", "ERROR")):
            failed += 1
        print(f"{path}: {result}")

    print(f"\n{changed} changed, {failed} skipped/failed, {len(targets)} inspected")
    if changed and not args.dry_run:
        print("restart hermes-webui for this to take effect:")
        print("  systemctl restart hermes-webui")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

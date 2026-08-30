#!/usr/bin/env node
/**
 * Let a plain admin read GET /api/hermes/runtime-versions on the installed
 * hermes-web-ui bundle.
 *
 * Why this patch exists: 0.7.1's ChatPanel.confirmNewChat() probes that route
 * to decide whether the Hermes runtime needs installing, but the route is
 * gated on requireSuperAdmin. A plain admin gets 403, the client can only read
 * that as "runtime missing", and it routes them to hermes.agentManager -- which
 * is itself super_admin-only, so the guard bounces them back to the chat page.
 * Net effect: the New Chat button flashes access-denied and does nothing.
 * On hs.xlingo.fun that was 6 of 7 accounts.
 *
 * The mutating routes (activate / download / delete / restart-webui) keep
 * requireSuperAdmin -- only the read-only inventory is relaxed.
 *
 * The upstream-correct fix is the one-line change in
 * packages/server/src/modules/hermes/routes/runtime-versions.ts (already made
 * on this branch). This script exists because the server runs upstream's
 * published bundle, so that source change does not reach it.
 *
 * Minified identifiers change on every upstream build, so nothing here is
 * hardcoded: both guards are located by their error strings and the route by
 * its literal path. Idempotent, backs up first, and rolls back if the patched
 * file fails `node --check`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'

const FILE = process.argv[2]
  || '/usr/lib/node_modules/hermes-web-ui/dist/server/index.js'
const ROUTE = '/api/hermes/runtime-versions'

const src = readFileSync(FILE, 'utf8')

// ── locate the two guards by the message each one sends ──
// requireSuperAdmin: role !== 'super_admin'
const superRe = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^}]{0,120}?Super administrator privileges are required/
// requireAdmin: role !== 'super_admin' && role !== 'admin'
const adminRe = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^}]{0,200}?[^r]Administrator privileges are required/

const superName = src.match(superRe)?.[1]
const adminName = src.match(adminRe)?.[1]

if (!superName) fail('could not locate requireSuperAdmin in the bundle')
if (!adminName) fail('could not locate requireAdmin in the bundle')
if (superName === adminName) fail(`guards resolved to the same name (${superName})`)

console.log(`  requireSuperAdmin -> ${superName}`)
console.log(`  requireAdmin      -> ${adminName}`)

// ── the single registration we touch ──
const already = new RegExp(`\\.get\\("${escape(ROUTE)}",${escape(adminName)},`)
if (already.test(src)) {
  console.log('ALREADY PATCHED - no change')
  process.exit(0)
}

const target = `.get("${ROUTE}",${superName},`
const hits = src.split(target).length - 1
if (hits !== 1) fail(`route registration found ${hits} times (expected exactly 1)`)

const patched = src.replace(target, `.get("${ROUTE}",${adminName},`)

// ── write with backup + syntax gate ──
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
const backup = `${FILE}.bak.${stamp}`
copyFileSync(FILE, backup)
console.log(`  backup: ${backup}`)

writeFileSync(FILE, patched)

try {
  execFileSync(process.execPath, ['--check', FILE], { stdio: 'pipe' })
  console.log('  node --check: OK')
} catch (err) {
  copyFileSync(backup, FILE)
  fail(`syntax error - reverted from backup\n${err.stderr?.toString() || err.message}`)
}

// ── prove the mutating routes were left alone ──
const stillGuarded = [
  'active-runtime', 'runtime-root', 'active-webui', 'runtime/download',
  'restart-webui', 'webui/download',
].filter(p => !patched.includes(`"${ROUTE}/${p}",${superName},`))

if (stillGuarded.length) {
  copyFileSync(backup, FILE)
  fail(`mutating routes lost their super_admin guard: ${stillGuarded.join(', ')} - reverted`)
}
console.log('  mutating routes still super_admin: OK')
console.log('PATCHED OK')

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(msg) {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

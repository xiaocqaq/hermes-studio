import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The read-only runtime inventory must stay reachable by a plain admin.
//
// ChatPanel.confirmNewChat() probes GET /api/hermes/runtime-versions to decide
// whether the Hermes runtime needs installing. That is an ordinary user action,
// so gating the read on super_admin makes the probe answer 403 for every plain
// admin; the client cannot distinguish "not installed" from "not allowed to
// ask" and routes them to the installer, which is itself super_admin-only.
// On production that left 6 of 7 accounts unable to start a chat at all.
//
// Everything that installs, activates, deletes or restarts must stay
// super_admin -- this test pins the split in both directions.
describe('runtime-versions route ACL', () => {
  const source = readFileSync(
    'packages/server/src/modules/hermes/routes/runtime-versions.ts',
    'utf8',
  )

  it('lets a plain admin read the runtime inventory', () => {
    expect(source).toMatch(
      /\.get\(\s*'\/api\/hermes\/runtime-versions'\s*,\s*requireAdmin\s*,/,
    )
  })

  it('keeps every mutating runtime-version route on super_admin', () => {
    const lines = source
      .split('\n')
      .filter(line => /runtimeVersionRoutes\.(post|delete|put|patch)\(/.test(line))

    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line, `mutating route must require super_admin: ${line.trim()}`)
        .toContain('requireSuperAdmin')
    }
  })

  it('keeps the job-inspection reads on super_admin', () => {
    // Download jobs expose remote URLs and progress for operations only a
    // super_admin can start, so they stay behind the stricter gate.
    expect(source).toMatch(
      /\.get\(\s*'\/api\/hermes\/runtime-versions\/jobs'\s*,\s*requireSuperAdmin\s*,/,
    )
    expect(source).toMatch(
      /\.get\(\s*'\/api\/hermes\/runtime-versions\/jobs\/:id'\s*,\s*requireSuperAdmin\s*,/,
    )
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Regression guard for the 0.7.1 upstream regression that locked every
// non-super_admin account out of creating a Hermes session.
//
// confirmNewChat() probes GET /api/hermes/runtime-versions to decide whether the
// runtime needs installing. That route is gated behind requireSuperAdmin, so for
// an ordinary admin it answers 403 -- and the original catch-all treated ANY
// failure as "runtime missing" and pushed the user to hermes.agentManager.
// That route is itself meta.requiresSuperAdmin, so the guard bounced them
// straight back to hermes.chat: the New Chat button appeared to do nothing but
// flash an access-denied toast. 6 of 7 accounts on production were affected.
//
// A 403/401 means "you may not read the runtime inventory" -- it carries no
// information about whether the runtime is installed, so it must not be
// treated as absence.
describe('ChatPanel runtime probe permission handling', () => {
  const chatPanel = readFileSync(
    'packages/client/src/components/hermes/chat/ChatPanel.vue',
    'utf8',
  )

  it('does not route to the installer when the runtime probe is merely forbidden', () => {
    const start = chatPanel.indexOf('async function confirmNewChat()')
    expect(start).toBeGreaterThan(-1)
    const body = chatPanel.slice(start, chatPanel.indexOf('\n}', start))

    // The catch must inspect the HTTP status rather than swallowing everything.
    expect(body).toContain('catch (error)')
    expect(body).toMatch(/status\s*!==\s*403/)
    expect(body).toMatch(/status\s*!==\s*401/)

    // A bare `} catch {` in the probe's own try block is exactly the
    // regression: it cannot tell "not installed" from "not allowed to ask".
    // Scope to the probe's try/catch only -- the sibling coding-agent block
    // below legitimately catches everything, since it only warns.
    const probeIdx = body.indexOf('fetchRuntimeVersionStatus')
    expect(probeIdx).toBeGreaterThan(-1)
    const probeBlock = body.slice(probeIdx, body.indexOf('finally', probeIdx))
    expect(probeBlock).not.toMatch(/\}\s*catch\s*\{/)
  })

  it('still sends the user to the installer when the runtime is genuinely absent', () => {
    expect(chatPanel).toContain('!status.hermes.agentVersion && !selectedCli?.version')
    expect(chatPanel).toContain(
      'router.push({ name: "hermes.agentManager", query: { runtime: "install" } })',
    )
  })
})

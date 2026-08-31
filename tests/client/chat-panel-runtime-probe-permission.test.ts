import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Creating a Hermes session must not depend on a super_admin-only endpoint.
//
// History: 0.7.1 probed GET /api/hermes/runtime-versions here to decide whether
// the runtime needed installing. That route is requireSuperAdmin, so a plain
// admin got 403; the catch-all read any failure as "runtime missing" and routed
// them to hermes.agentManager, which is itself meta.requiresSuperAdmin, so the
// guard bounced them back to hermes.chat. The New Chat button flashed
// access-denied and did nothing -- 6 of 7 production accounts affected.
//
// Upstream fixed it properly in #2805 by adding GET /api/agents/availability,
// which carries no role guard, and by never redirecting from the catch. This
// test pins that shape so the coupling cannot come back.
describe('ChatPanel Hermes availability probe', () => {
  const chatPanel = readFileSync(
    'packages/client/src/components/hermes/chat/ChatPanel.vue',
    'utf8',
  )

  const confirmNewChat = (() => {
    const start = chatPanel.indexOf('async function confirmNewChat()')
    expect(start).toBeGreaterThan(-1)
    return chatPanel.slice(start, chatPanel.indexOf('\n}', start))
  })()

  it('probes the unguarded availability endpoint, not the super_admin inventory', () => {
    expect(confirmNewChat).toContain('fetchAgentAvailabilitySnapshot()')
    // runtime-versions is requireSuperAdmin; reaching for it here is the bug.
    expect(confirmNewChat).not.toContain('fetchRuntimeVersionStatus')
  })

  it('never routes to the installer just because the probe failed', () => {
    const probeIdx = confirmNewChat.indexOf('fetchAgentAvailabilitySnapshot')
    const catchIdx = confirmNewChat.indexOf('catch', probeIdx)
    const finallyIdx = confirmNewChat.indexOf('finally', catchIdx)
    expect(catchIdx).toBeGreaterThan(-1)
    expect(finallyIdx).toBeGreaterThan(catchIdx)

    // A probe failure carries no information about what is installed, so the
    // catch must not navigate anywhere.
    const catchBlock = confirmNewChat.slice(catchIdx, finallyIdx)
    expect(catchBlock).not.toContain('router.push')
  })

  it('only sends a super_admin to the installer when the runtime is truly absent', () => {
    expect(confirmNewChat).toContain('=== "not-installed"')
    expect(confirmNewChat).toContain('isSuperAdmin.value')
    // Everyone else gets told, rather than bounced off a route they cannot open.
    expect(confirmNewChat).toContain('codingAgents.installRequired')
  })
})

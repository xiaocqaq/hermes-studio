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
// which carries no role guard, and by never redirecting from the catch. 0.7.37
// then reshaped ChatPanel: the old `confirmNewChat` was split, and the guard now
// lives in `submitNewChat`. This test pins the same shape at its new home so the
// coupling cannot come back.
describe('ChatPanel Hermes availability probe', () => {
  const chatPanel = readFileSync(
    'packages/client/src/components/hermes/chat/ChatPanel.vue',
    'utf8',
  )

  // The Hermes-specific pre-flight guard inside submitNewChat: everything from
  // the `newChatAgent.value === "hermes"` branch up to the next agent branch.
  const hermesGuard = (() => {
    const start = chatPanel.indexOf('if (newChatAgent.value === "hermes") {')
    expect(start).toBeGreaterThan(-1)
    const end = chatPanel.indexOf('if (isNewChatExternalCodingAgent.value) {', start)
    expect(end).toBeGreaterThan(start)
    return chatPanel.slice(start, end)
  })()

  it('probes the unguarded availability endpoint, not the super_admin inventory', () => {
    expect(hermesGuard).toContain('fetchAgentAvailabilitySnapshot()')
    // runtime-versions is requireSuperAdmin; reaching for it here is the bug.
    expect(hermesGuard).not.toContain('fetchRuntimeVersionStatus')
  })

  it('never routes to the installer just because the probe failed', () => {
    const probeIdx = hermesGuard.indexOf('fetchAgentAvailabilitySnapshot')
    const catchIdx = hermesGuard.indexOf('catch', probeIdx)
    expect(probeIdx).toBeGreaterThan(-1)
    expect(catchIdx).toBeGreaterThan(probeIdx)

    // A probe failure carries no information about what is installed, so the
    // catch must not navigate anywhere. It is the tail of the guard block, so
    // everything from the catch onward is the failure path.
    const catchBlock = hermesGuard.slice(catchIdx)
    expect(catchBlock).not.toContain('router.push')
    expect(catchBlock).toContain('console.warn')
  })

  it('only sends a super_admin to the installer when the runtime is truly absent', () => {
    expect(hermesGuard).toContain('=== "not-installed"')
    expect(hermesGuard).toContain('isSuperAdmin.value')
    // Everyone else gets told, rather than bounced off a route they cannot open.
    expect(hermesGuard).toContain('codingAgents.installRequired')
  })
})

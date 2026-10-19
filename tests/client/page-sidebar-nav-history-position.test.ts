import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const navSource = readFileSync(
  'packages/client/src/components/layout/PageSidebarNav.vue',
  'utf8',
)
const historyViewSource = readFileSync(
  'packages/client/src/views/hermes/HistoryView.vue',
  'utf8',
)

// Fork: the conversation switch only renders single chat + history. Group chat
// (群组) and workflow (工作流) are intentionally trimmed from the navigation
// surfaces; both routes still exist for direct URLs. See
// docs/harness/fork-customizations.md before restoring them.
describe('page sidebar conversation switch', () => {
  it('places history after single chat', () => {
    const switchStart = navSource.indexOf('class="conversation-switch"')
    const switchSource = navSource.slice(switchStart)

    expect(switchStart).toBeGreaterThan(-1)
    expect(switchSource.indexOf('@click="openChat"')).toBeGreaterThan(-1)
    expect(switchSource.indexOf('@click="openChat"')).toBeLessThan(
      switchSource.indexOf('@click="openHistory"'),
    )
    expect(navSource.match(/@click="openHistory"/g)).toHaveLength(1)
  })

  it('keeps group chat and workflow out of the conversation switch', () => {
    const switchStart = navSource.indexOf('class="conversation-switch"')
    const switchSource = navSource.slice(switchStart)

    expect(switchSource).not.toContain('@click="openGroupChat"')
    expect(switchSource).not.toContain('@click="openWorkflow"')
    expect(navSource).not.toContain("t('sidebar.groupChat')")
    expect(navSource).not.toContain("t('sidebar.workflow')")
  })

  it('shows the conversation switch on the history page', () => {
    const historyNav = historyViewSource.match(/<PageSidebarNav[\s\S]*?\/>/)?.[0] || ''

    expect(historyNav).toContain('active="history"')
    expect(historyNav).not.toContain('hide-mode-switch')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// This fork keeps device connections, group chat, workflow and the API-relay
// partner entry out of the navigation. Upstream 0.7.37 reintroduced all of them
// in the new desktop navigation rail, so guard the rail explicitly.
// See docs/harness/fork-customizations.md.
const railPath = 'packages/client/src/components/layout/StudioNavigationRail.vue'
const sidebarPath = 'packages/client/src/components/layout/PageSidebarNav.vue'

function readRail(): string {
  return readFileSync(railPath, 'utf8')
}

describe('Navigation surfaces', () => {
  it('keeps device connections out of the navigation rail', () => {
    const source = readRail()
    expect(source).not.toContain("key: 'connections'")
    expect(source).not.toContain('sidebar.connections')
  })

  it('keeps group chat and workflow out of the navigation rail', () => {
    const source = readRail()
    expect(source).not.toContain("key: 'group'")
    expect(source).not.toContain("key: 'workflow'")
    expect(source).not.toContain('sidebar.groupChat')
    expect(source).not.toContain('sidebar.workflow')
  })

  it('keeps the API relay partner entry out of the navigation rail', () => {
    const source = readRail()
    expect(source).not.toContain('hermes.apiRelay')
    expect(source).not.toContain('relay-logo.png')
    expect(source).not.toContain('sidebar.apiRelay')
  })

  it('links the learning journey from both navigation surfaces', () => {
    expect(readRail()).toContain("key: 'journey'")
    const sidebar = readFileSync(sidebarPath, 'utf8')
    expect(sidebar).toContain('openJourney')
    expect(sidebar).toContain('sidebar.journey')
  })

  it('keeps the retired jobs and kanban tabs out of the page sidebar', () => {
    const sidebar = readFileSync(sidebarPath, 'utf8')
    expect(sidebar).not.toContain('sidebar.jobs')
    expect(sidebar).not.toContain('sidebar.kanban')
  })
})

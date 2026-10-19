import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Keep the desktop rail on the same device metaphor. The compact sidebar no
// longer lists connections in this fork (see the "remove ad buttons" commit),
// so only the rail is asserted here.
const path = 'M3 4h14a1 1 0 0 1 1 1v4M3 4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h9M7 16v4M5 20h7M15 9h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1M17 18h2'
describe('Device connections icon', () => {
  it('uses the monitor + phone outline in the navigation rail', () => {
    const source = readFileSync('packages/client/src/components/layout/StudioNavigationRail.vue', 'utf8')
    expect(source).toContain(path)
  })
  it('keeps the workflow branch icon distinct', () => {
    const source = readFileSync('packages/client/src/components/layout/StudioNavigationRail.vue', 'utf8')
    const workflow = source.split("key: 'workflow'")[1].split('\n')[0]
    const connections = source.split("key: 'connections'")[1].split('\n')[0]
    expect(workflow).not.toContain(path)
    expect(connections).toContain(path)
  })
})

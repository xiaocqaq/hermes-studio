import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'
import {
  closeAllBrowserSessions,
  closeBrowserSession,
  createBrowserTools,
  listActiveBrowserSessions,
  sweepOrphanBrowserSessions,
} from '../../packages/ekko-agent/src/index'

/**
 * The agent-browser daemon is not a child of this process: the CLI that starts
 * it exits immediately, leaving the daemon and a full Chrome tree behind. On a
 * memory-tight server those strays accumulated at ~100 MB each until earlyoom
 * started SIGTERMing hermes-webui on every startup burst. These tests pin the
 * teardown path that closes them.
 */

const mockedSpawn = vi.mocked(spawn)
let tmpRoot = ''

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ekko-browser-teardown-'))
  process.env.EKKO_AGENT_BROWSER_TMPDIR = tmpRoot
})

afterAll(() => {
  delete process.env.EKKO_AGENT_BROWSER_TMPDIR
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.resetAllMocks()
  process.env.AGENT_BROWSER_BIN = '/tmp/agent-browser'
})

afterEach(() => {
  delete process.env.AGENT_BROWSER_BIN
})

describe('agent-browser session teardown', () => {
  it('registers a session when a browser command runs and closes it on request', async () => {
    mockBrowserSpawn({ success: true, data: { snapshot: 'ok', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'teardown-one' })

    const sessionName = hashedSession('teardown-one')
    expect(listActiveBrowserSessions()).toContain(sessionName)
    expect(existsSync(path.join(tmpRoot, `eab_${sessionName}`))).toBe(true)

    mockBrowserSpawn({ success: true })
    await expect(closeBrowserSession('teardown-one')).resolves.toBe(true)

    const closeCall = mockedSpawn.mock.calls.at(-1)
    expect(closeCall?.[1]).toEqual(['--session', sessionName, '--json', 'close'])
    expect(closeCall?.[2]).toMatchObject({ shell: false, stdio: 'ignore' })
    expect(listActiveBrowserSessions()).not.toContain(sessionName)
  })

  it('accepts the derived session name as well as the raw session id', async () => {
    mockBrowserSpawn({ success: true, data: { snapshot: 'ok', refs: {} } })
    await snapshotTool().execute({}, { sessionId: 'by-name' })

    mockBrowserSpawn({ success: true })
    await expect(closeBrowserSession(hashedSession('by-name'))).resolves.toBe(true)
    expect(listActiveBrowserSessions()).not.toContain(hashedSession('by-name'))
  })

  it('does not spawn anything for a session that never started a daemon', async () => {
    // Running the CLI against a sessionless socket dir would *start* a daemon,
    // which is the opposite of closing one.
    await expect(closeBrowserSession('never-opened-session')).resolves.toBe(false)
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('closes every registered session on shutdown', async () => {
    expect(listActiveBrowserSessions()).toEqual([])

    mockBrowserSpawn({ success: true, data: { snapshot: 'a', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'shutdown-a' })
    mockBrowserSpawn({ success: true, data: { snapshot: 'b', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'shutdown-b' })

    mockBrowserSpawn({ success: true })
    mockBrowserSpawn({ success: true })
    await expect(closeAllBrowserSessions()).resolves.toEqual({ attempted: 2, closed: 2, failed: 0 })

    expect(listActiveBrowserSessions()).toEqual([])
    const closedSessions = mockedSpawn.mock.calls.slice(2).map(call => call[1]?.[1]).sort()
    expect(closedSessions).toEqual([hashedSession('shutdown-a'), hashedSession('shutdown-b')].sort())
  })

  it('is a no-op when there is nothing to close', async () => {
    await expect(closeAllBrowserSessions()).resolves.toEqual({ attempted: 0, closed: 0, failed: 0 })
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('reports a failed close but still forgets the session', async () => {
    mockBrowserSpawn({ success: true, data: { snapshot: 'c', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'close-fails' })

    mockBrowserSpawn({}, 1)
    await expect(closeBrowserSession('close-fails')).resolves.toBe(false)
    // Retrying forever would stall every shutdown, so the entry is dropped and
    // the daemon's own idle timer stays as the last backstop.
    expect(listActiveBrowserSessions()).not.toContain(hashedSession('close-fails'))
  })

  it('survives a spawn failure without throwing', async () => {
    mockBrowserSpawn({ success: true, data: { snapshot: 'd', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'spawn-error' })

    mockedSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    await expect(closeBrowserSession('spawn-error')).resolves.toBe(false)
  })

  it('gives up on a close that hangs, killing the CLI', async () => {
    mockBrowserSpawn({ success: true, data: { snapshot: 'e', refs: {} } })
    await snapshotTool().execute({}, { browserSessionId: 'hangs' })

    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
    child.kill = vi.fn()
    mockedSpawn.mockImplementationOnce(() => child as any)

    await expect(closeBrowserSession('hangs', { timeoutMs: 20 })).resolves.toBe(false)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('sweeps daemons left behind by a previous process', async () => {
    // A SIGKILLed process leaves its socket dirs on disk with no registry entry.
    rmSync(tmpRoot, { recursive: true, force: true })
    mkdirSync(tmpRoot, { recursive: true })
    const orphan = 'e_00dead0000'
    mkdirSync(path.join(tmpRoot, `eab_${orphan}`), { recursive: true })
    mkdirSync(path.join(tmpRoot, 'not-a-browser-dir'), { recursive: true })

    mockBrowserSpawn({ success: true })
    await expect(sweepOrphanBrowserSessions()).resolves.toEqual({ attempted: 1, closed: 1, failed: 0 })
    expect(mockedSpawn).toHaveBeenCalledTimes(1)
    expect(mockedSpawn.mock.calls[0]?.[1]).toEqual(['--session', orphan, '--json', 'close'])
  })
})

function snapshotTool() {
  const tool = createBrowserTools().find(item => item.definition.name === 'browser_snapshot')
  if (!tool) throw new Error('browser_snapshot tool is missing')
  return tool
}

function hashedSession(value: string): string {
  return `e_${createHash('sha256').update(value).digest('hex').slice(0, 10)}`
}

function mockBrowserSpawn(payload: unknown, exitCode = 0): void {
  mockedSpawn.mockImplementationOnce((_command, _args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
    }
    child.kill = vi.fn()
    const stdio = Array.isArray(options?.stdio) ? options.stdio : []
    if (typeof stdio[1] === 'number') {
      writeSync(stdio[1], JSON.stringify(payload))
    }
    process.nextTick(() => {
      child.emit('close', exitCode)
    })
    return child as any
  })
}

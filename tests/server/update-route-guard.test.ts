import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleUpdateMock = vi.fn(async () => {})
const previewStatusMock = vi.fn(async () => {})

vi.mock('../../packages/server/src/modules/studio/controllers/update', () => ({
  handleUpdate: handleUpdateMock,
  previewStatus: previewStatusMock,
  previewTags: vi.fn(async () => {}),
  preparePreview: vi.fn(async () => {}),
  installPreview: vi.fn(async () => {}),
  startPreview: vi.fn(async () => {}),
  stopPreview: vi.fn(async () => {}),
}))

async function runUpdateRoute(path: string, method: 'post' | 'get', ctx: any) {
  const { updateRoutes } = await import('../../packages/server/src/modules/studio/routes/update')
  const layer = updateRoutes.stack.find(
    (entry: any) => entry.path === path && entry.methods.includes(method.toUpperCase()),
  )
  if (!layer) throw new Error(`Missing update route ${method.toUpperCase()} ${path}`)

  let index = -1
  async function dispatch(nextIndex: number): Promise<void> {
    if (nextIndex <= index) throw new Error('next() called multiple times')
    index = nextIndex
    const fn = layer.stack[nextIndex]
    if (!fn) return
    await fn(ctx, () => dispatch(nextIndex + 1))
  }

  await dispatch(0)
}

function createContext(role?: string) {
  return {
    state: role ? { user: { id: 1, username: 'someone', role } } : {},
    body: null as unknown,
    status: 404,
  } as any
}

describe('update route super-admin guard', () => {
  beforeEach(async () => {
    vi.resetModules()
    handleUpdateMock.mockClear()
    previewStatusMock.mockClear()
    const { configureSuperAdminMiddleware } = await import(
      '../../packages/server/src/modules/studio/middleware/super-admin'
    )
    const { requireSuperAdmin } = await import('../../packages/server/src/modules/studio/middleware/auth')
    configureSuperAdminMiddleware(requireSuperAdmin)
  })

  it('rejects an ordinary logged-in user before the update handler runs', async () => {
    const ctx = createContext('user')

    await runUpdateRoute('/api/studio/update', 'post', ctx)

    expect(handleUpdateMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Super administrator privileges are required' })
  })

  it('rejects a plain admin, matching the sibling preview routes', async () => {
    const ctx = createContext('admin')

    await runUpdateRoute('/api/studio/update', 'post', ctx)

    expect(handleUpdateMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('rejects an unauthenticated request', async () => {
    const ctx = createContext()

    await runUpdateRoute('/api/studio/update', 'post', ctx)

    expect(handleUpdateMock).not.toHaveBeenCalled()
    expect(ctx.status).toBe(403)
  })

  it('lets a super admin trigger the update handler', async () => {
    const ctx = createContext('super_admin')

    await runUpdateRoute('/api/studio/update', 'post', ctx)

    expect(ctx.status).not.toBe(403)
    expect(handleUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('guards every version preview route as well', async () => {
    const guardedRoutes: Array<[string, 'post' | 'get']> = [
      ['/api/studio/update/preview', 'get'],
      ['/api/studio/update/preview/tags', 'get'],
      ['/api/studio/update/preview/prepare', 'post'],
      ['/api/studio/update/preview/install', 'post'],
      ['/api/studio/update/preview/start', 'post'],
      ['/api/studio/update/preview/stop', 'post'],
    ]

    for (const [path, method] of guardedRoutes) {
      const ctx = createContext('user')
      await runUpdateRoute(path, method, ctx)
      expect(ctx.status, `${method.toUpperCase()} ${path} must reject a plain user`).toBe(403)
    }
  })
})

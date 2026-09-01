// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  fetchVersionDownloadJobs: vi.fn(),
  restartWebUiAfterRuntimeChange: vi.fn(),
}))
const desktop = vi.hoisted(() => ({
  bridge: null as null | { isDesktop: boolean; restartApp?: ReturnType<typeof vi.fn> },
}))
const message = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/api/hermes/runtime-versions', () => api)
vi.mock('@/utils/desktop-bridge', () => ({
  desktopBridge: () => desktop.bridge,
  // The super-admin gate imports @/api/client, which pulls in the router; the
  // router asks for this bridge probe at module scope.
  hasDesktopBrowserBridge: () => false,
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.version ? `${key}:${params.version}` : key,
  }),
}))
vi.mock('naive-ui', () => ({
  NButton: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  NCard: { template: '<section><h1><slot name="header" /></h1><slot /><footer><slot name="footer" /></footer></section>' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /></div>' },
  useMessage: () => message,
}))

import RuntimeRestartPrompt from '@/components/layout/RuntimeRestartPrompt.vue'
import { useRuntimeRestartPrompt } from '@/composables/useRuntimeRestartPrompt'

function completedRuntimeJob(id = 'runtime-job-1') {
  return {
    id,
    kind: 'runtime',
    source: 'github',
    version: '0.20.6',
    status: 'completed',
    stage: 'completed',
    message: 'runtimeVersions.jobStage.completed',
    error: '',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function jwtForRole(role: 'super_admin' | 'admin'): string {
  // getStoredUserRole() only base64-decodes the payload segment; signature is unused.
  return `header.${btoa(JSON.stringify({ role, username: role, sub: 1 }))}.signature`
}

describe('RuntimeRestartPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
    // The jobs endpoint is requireSuperAdmin, so the prompt only polls for a
    // super admin. Seed that role for the default cases.
    localStorage.setItem('hermes_api_key', jwtForRole('super_admin'))
    useRuntimeRestartPrompt().clearRuntimeRestart()
    api.fetchVersionDownloadJobs.mockReset()
    api.restartWebUiAfterRuntimeChange.mockReset()
    api.fetchVersionDownloadJobs.mockResolvedValue({ jobs: [completedRuntimeJob()] })
    api.restartWebUiAfterRuntimeChange.mockResolvedValue({ success: true })
    desktop.bridge = null
    message.error.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('waits for confirmation after a Runtime download completes', async () => {
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    expect(wrapper.get('[data-testid="runtime-restart-prompt"]').text()).toContain('0.20.6')
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="runtime-restart-later"]').trigger('click')

    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(false)
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('restarts only the Desktop client when confirmed in Desktop', async () => {
    const restartApp = vi.fn().mockResolvedValue(true)
    desktop.bridge = { isDesktop: true, restartApp }
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    await wrapper.get('[data-testid="runtime-restart-now"]').trigger('click')
    await flushPromises()

    expect(restartApp).toHaveBeenCalledTimes(1)
    expect(api.restartWebUiAfterRuntimeChange).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('restarts only the standalone Web UI when confirmed in a browser', async () => {
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()

    await wrapper.get('[data-testid="runtime-restart-now"]').trigger('click')
    await flushPromises()

    expect(api.restartWebUiAfterRuntimeChange).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  // Regression: GET /api/hermes/runtime-versions/jobs is requireSuperAdmin, and the
  // shared request helper turns every local-BFF 403 into an "access denied" toast.
  // Polling it every 2s as a plain admin papered the whole UI with that toast.
  it('never polls the super-admin jobs endpoint for a plain admin', async () => {
    localStorage.setItem('hermes_api_key', jwtForRole('admin'))
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    expect(api.fetchVersionDownloadJobs).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="runtime-restart-prompt"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not poll when no session token is stored', async () => {
    localStorage.clear()
    const wrapper = mount(RuntimeRestartPrompt)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(api.fetchVersionDownloadJobs).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

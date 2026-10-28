// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// GET/DELETE /api/auth/locked-ips are requireSuperAdmin on the server, and
// packages/client/src/api/client.ts dispatches a global "forbidden" toast on
// every local-BFF 403 before the promise rejects. A plain admin therefore sees
// a red access-denied notification from AccountSettings even though its catch
// swallows the error -- same failure mode as the RuntimeRestartPrompt incident.
// The panel must stay invisible and unrequested for non-super-admins.
const api = vi.hoisted(() => ({
  fetchLockedIps: vi.fn(),
  unlockSpecificIp: vi.fn(),
  unlockAllIps: vi.fn(),
  changePassword: vi.fn(),
  changeUsername: vi.fn(),
  updateMyAvatar: vi.fn(),
  resetMyAvatar: vi.fn(),
  fetchCurrentUser: vi.fn(),
  fetchMyAvatar: vi.fn(),
}))
const client = vi.hoisted(() => ({ isStoredSuperAdmin: vi.fn(() => false) }))

vi.mock('@/api/studio/auth', () => api)
vi.mock('@/api/client', () => ({ ...client, getStoredUsername: () => 'admin' }))
vi.mock('@/components/hermes/profiles/ProfileAvatar.vue', () => ({
  default: { props: ['name', 'avatar', 'size'], template: '<span class="profile-avatar" />' },
}))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && 'count' in params ? `${key}:${params.count}` : key,
  }),
}))
vi.mock('naive-ui', () => ({
  NButton: {
    props: ['loading', 'type', 'size', 'ghost'],
    emits: ['click'],
    template: '<button :disabled="loading" @click="$emit(\'click\')"><slot /></button>',
  },
  NInput: { props: ['value', 'type', 'placeholder', 'showPasswordOn'], template: '<input />' },
  NModal: { props: ['show'], template: '<div v-if="show"><slot /><slot name="action" /></div>' },
  NForm: { template: '<form><slot /></form>' },
  NFormItem: { props: ['label'], template: '<div class="form-item"><slot /></div>' },
  NPopconfirm: { template: '<span><slot name="trigger" /><slot /></span>' },
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import AccountSettings from '@/components/hermes/settings/AccountSettings.vue'

function mountSettings() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(AccountSettings, { global: { plugins: [pinia] } })
}

describe('AccountSettings locked-IP panel permission', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.fetchLockedIps.mockReset().mockResolvedValue([])
    // AccountSettings also hydrates the shared account store on mount; give it
    // resolvable values so the identity load does not reject in the background.
    api.fetchCurrentUser.mockReset().mockResolvedValue({ username: 'admin' })
    api.fetchMyAvatar.mockReset().mockResolvedValue(null)
    client.isStoredSuperAdmin.mockReset().mockReturnValue(false)
  })

  it('never calls the super_admin-only locked-ips endpoint for a plain admin', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    expect(client.isStoredSuperAdmin).toHaveBeenCalled()
    expect(api.fetchLockedIps).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('settings.lockedIps.title')
    wrapper.unmount()
  })

  it('loads and renders the panel for a super admin', async () => {
    client.isStoredSuperAdmin.mockReturnValue(true)
    api.fetchLockedIps.mockResolvedValue([
      { ip: '203.0.113.7', type: 'password', lockedUntil: Date.now() + 60_000 },
    ])

    const wrapper = mountSettings()
    await flushPromises()

    expect(api.fetchLockedIps).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('settings.lockedIps.title')
    expect(wrapper.text()).toContain('203.0.113.7')
    wrapper.unmount()
  })
})

// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routerPush = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: () => false,
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({ openSessionSearch: vi.fn() }),
}))

vi.mock('naive-ui', () => ({
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
}))

import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'

describe('PageSidebarNav management links', () => {
  beforeEach(() => {
    routerPush.mockReset()
  })

  it('exposes Jobs and Kanban from the main chat sidebar', async () => {
    const wrapper = mount(PageSidebarNav, {
      props: { active: 'chat' },
    })
    const buttons = wrapper.findAll('.page-sidebar-tab')

    await buttons.find(button => button.text() === 'sidebar.jobs')!.trigger('click')
    expect(routerPush).toHaveBeenLastCalledWith({ name: 'hermes.jobs' })

    await buttons.find(button => button.text() === 'sidebar.kanban')!.trigger('click')
    expect(routerPush).toHaveBeenLastCalledWith({
      name: 'hermes.kanban',
      query: { board: 'default' },
    })
  })
})

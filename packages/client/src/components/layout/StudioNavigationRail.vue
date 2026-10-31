<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NTooltip } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import PageSidebarFooter from './PageSidebarFooter.vue'
import { useMobileNavigation } from '@/composables/usePageSidebar'

const route = useRoute()
const { t } = useI18n()
const canManageAgents = computed(() => isStoredSuperAdmin())
// Fork: the rail is deliberately limited to the entries this deployment uses.
// `connections` (设备互联), `apiRelay` (the AK partner entry), `groupChat` (群组)
// and `workflow` (工作流) are all removed on purpose — see
// docs/harness/fork-customizations.md. Their routes still exist, so a bookmarked
// URL keeps working; only the navigation surface is trimmed.
const entries = computed(() => [
  { key: 'person', route: 'hermes.person', label: 'person.subtitle', avatar: deploymentUrl('/person/idle.gif') },
  { key: 'chat', route: 'hermes.chat', label: 'sidebar.singleChat', path: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { key: 'history', route: 'hermes.history', label: 'sidebar.history', path: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2' },
  ...(canManageAgents.value ? [{ key: 'agents', route: 'hermes.agentManager', label: 'sidebar.agentManager', path: 'M12 8V4H8M7 8h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3M2 14h2M20 14h2M9 13v2M15 13v2' }] : []),
  { key: 'models', route: 'hermes.models', label: 'sidebar.models', path: 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1' },
  { key: 'journey', route: 'hermes.journey', label: 'sidebar.journey', path: 'M12 2v20M2 12h20M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0' },
  { key: 'usage', route: 'hermes.usage', label: 'sidebar.usage', path: 'M3 12h4v9H3zM10 7h4v14h-4zM17 3h4v18h-4z' },
])
const activeKey = computed(() => {
  const name = String(route.name || '')
  if (route.meta.hermesConfig || route.meta.ekkoConfig || route.meta.codingAgentConfig) return 'agents'
  if (['hermes.chat', 'hermes.session', 'hermes.globalAgent', 'hermes.globalAgentSession'].includes(name)) return 'chat'
  if (name.startsWith('hermes.groupChat')) return 'group'
  if (name.startsWith('hermes.history')) return 'history'
  return entries.value.find(entry => entry.route === name)?.key || 'settings'
})
const mobileNavigation = useMobileNavigation()
function handleNavigate(key: string) {
  if (mobileNavigation && ['agents', 'models', 'journey', 'usage'].includes(key)) {
    mobileNavigation.open.value = false
  }
}
</script>

<template>
  <aside class="studio-navigation-rail">
    <PageSidebarFooter rail collapsed />
    <nav class="studio-navigation-rail__nav">
      <NTooltip v-for="entry in entries" :key="entry.key" placement="right" trigger="hover">
        <template #trigger>
          <RouteLinkItem class="studio-navigation-rail__item" :to="{ name: entry.route }" :active="activeKey === entry.key" :aria-label="t(entry.label)" @click="handleNavigate(entry.key)">
            <img v-if="entry.avatar" class="studio-navigation-rail__avatar" :src="entry.avatar" width="32" height="32" alt="" aria-hidden="true" />
            <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="entry.path" /></svg>
          </RouteLinkItem>
        </template>
        {{ t(entry.label) }}
      </NTooltip>
      <!-- Fork: the AK / API-relay partner entry is intentionally not part of the
           navigation rail. It used to link out to an affiliate page, and this fork
           removed it from the compact sidebar as well (see the "remove ad buttons"
           commit). Keep it reachable only by URL so no ad surface is shipped. -->
    </nav>
    <div class="studio-navigation-rail__bottom">
      <NTooltip placement="right" trigger="hover">
        <template #trigger>
          <RouteLinkItem class="studio-navigation-rail__item" :to="{ name: 'hermes.settings' }" :active="activeKey === 'settings'" :aria-label="t('sidebar.settings')">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </RouteLinkItem>
        </template>
        {{ t('sidebar.settings') }}
      </NTooltip>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.studio-navigation-rail {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 $navigation-rail-width;
  flex-direction: column;
  align-items: center;
  width: $navigation-rail-width;
  min-height: 0;
  padding: calc(12px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  background: transparent;

  :deep(.page-sidebar-bottom) { width: 100%; padding: 0 0 calc(16px * var(--spacing-scale, 1)); }
  :deep(.page-sidebar-account-btn) { height: 44px; padding: calc(4px * var(--spacing-scale, 1)); }
}
.studio-navigation-rail__nav {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  overflow-y: auto;
  scrollbar-width: none;
}
.studio-navigation-rail__bottom { display: flex; flex-direction: column; gap: calc(8px * var(--spacing-scale, 1)); padding-top: 12px; }
.api-relay-logo { border-radius: var(--radius-component, 4px); }
.studio-navigation-rail__avatar { aspect-ratio: 1; flex-shrink: 0; border-radius: 4px; object-fit: contain; }
.studio-navigation-rail__item {
  display: grid;
  place-items: center;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  color: $text-muted;
  border-radius: $radius-sm;
  text-decoration: none;
  transition: background-color $transition-fast, color $transition-fast;
  -webkit-app-region: no-drag;

  &:hover { color: $text-primary; background: rgba(var(--accent-primary-rgb), 0.06); }
  &.active { color: $accent-primary; background: rgba(var(--accent-primary-rgb), 0.12); }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}
</style>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import thinkingImage from '@/assets/thinking.gif'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('./MarkdownRenderer.vue')).default)

defineProps<{
  reasoning?: string | null
  reasoningId?: string | number | null
  elapsed: string
}>()

const { t } = useI18n()
</script>

<template>
  <div class="live-reasoning-status">
    <div class="thinking-status">
      <img
        :src="thinkingImage"
        alt=""
        aria-hidden="true"
        class="thinking-avatar"
      >
      <div class="thinking-status-copy">
        <span class="thinking-status-label">{{ t('chat.thinkingInProgress') }}</span>
        <span class="thinking-status-time">{{ elapsed }}</span>
      </div>
    </div>
    <div
      v-if="reasoning"
      :key="reasoningId ?? reasoning"
      class="live-reasoning-detail"
      :data-reasoning-id="reasoningId"
    >
      <div class="live-reasoning-label">
        <span aria-hidden="true">💭</span>
        <span>{{ t('chat.thinkingLabel') }}</span>
      </div>
      <div class="live-reasoning-body">
        <MarkdownRenderer :content="reasoning" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.live-reasoning-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.thinking-status {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 40px;
}

.thinking-avatar {
  width: 40px;
  height: 40px;
  border-radius: $radius-md;
  object-fit: cover;
  flex-shrink: 0;

  .dark & {
    filter: brightness(1.18) contrast(1.08) saturate(1.08);
  }
}

.thinking-status-copy {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
  min-height: 20px;
}

.thinking-status-label {
  display: inline-flex;
  align-items: center;
  color: transparent;
  background: linear-gradient(105deg, $text-secondary 0%, $text-secondary 39%, $text-primary 48%, $text-primary 52%, $text-secondary 61%, $text-secondary 100%);
  background-size: 300% 100%;
  background-position: 0% 0;
  -webkit-background-clip: text;
  background-clip: text;
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  animation: thinking-label-shimmer 2.2s linear infinite;
  backface-visibility: hidden;
  contain: paint;
  transform: translateZ(0);
  will-change: background-position;

}

.thinking-status-time {
  display: inline-flex;
  align-items: center;
  margin-top: 2px;
  color: $text-secondary;
  font-family: $font-code;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  min-width: 44px;
}

.live-reasoning-detail {
  width: 520px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 10px;
  border-radius: $radius-sm;
  background: rgba(var(--bg-main-surface-rgb), 0.82);
  color: $text-primary;
  box-shadow: inset 0 0 0 1px rgba(var(--text-primary-rgb), 0.18);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.live-reasoning-label {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 500;
}

.live-reasoning-body {
  max-height: 220px;
  overflow-y: auto;
  color: $text-primary;
  font-size: 14px;
  line-height: 1.6;

  :deep(.markdown-body > :first-child) {
    margin-top: 0;
  }

  :deep(.markdown-body > :last-child) {
    margin-bottom: 0;
  }
}

@keyframes thinking-label-shimmer {
  0% {
    background-position: 100% 0;
  }

  100% {
    background-position: 0% 0;
  }
}

</style>

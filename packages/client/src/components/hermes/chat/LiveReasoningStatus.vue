<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import thinkingImage from '@/assets/thinking.gif'
import type { ChatAgentAvatar } from '@/utils/chat-agent-avatar'
import { personAvatarAnimation, personAvatarStyle } from '@/utils/chat-agent-avatar'

const props = withDefaults(defineProps<{
  reasoning?: string | null
  reasoningId?: string | number | null
  hideReasoning?: boolean
  activityLabel?: string
  elapsed: string
  agent?: ChatAgentAvatar
  deploymentSessionId?: string
}>(), {
  agent: () => ({ label: 'Hermes', src: deploymentUrl('/coding-agents/hermes.png') }),
})
const isEkko = computed(() => props.agent.label === 'Ekko')
const personThinking = computed(() => personAvatarAnimation(props.agent, 'thinking'))
const isPerson = computed(() => !!personThinking.value)
const avatarSrc = computed(() => personThinking.value || (isEkko.value ? thinkingImage : props.agent.src))

const { t } = useI18n()
const reasoningBody = ref<HTMLElement | null>(null)
let scrollFrame = 0
let visibleReasoningId = props.reasoningId

const reasoningLine = computed(() => {
  return (props.reasoning || '').replace(/\s+/g, ' ').trim()
})

function scrollReasoningToLatest(reset = false) {
  const element = reasoningBody.value
  if (!element) return

  cancelAnimationFrame(scrollFrame)
  if (reset) element.scrollLeft = 0

  const start = element.scrollLeft
  const target = Math.max(0, element.scrollWidth - element.clientWidth)
  const distance = target - start
  if (distance <= 0) {
    element.scrollLeft = target
    return
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    element.scrollLeft = target
    return
  }

  const duration = Math.min(120, Math.max(45, distance * 2.5))
  const startedAt = performance.now()
  const advance = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - (1 - progress) ** 3
    element.scrollLeft = start + distance * eased
    if (progress < 1) scrollFrame = requestAnimationFrame(advance)
  }
  scrollFrame = requestAnimationFrame(advance)
}

watch(
  [reasoningLine, () => props.reasoningId],
  async () => {
    const reset = visibleReasoningId !== props.reasoningId
    visibleReasoningId = props.reasoningId
    await nextTick()
    scrollReasoningToLatest(reset)
  },
  { immediate: true, flush: 'post' },
)

onBeforeUnmount(() => cancelAnimationFrame(scrollFrame))
</script>

<template>
  <div class="live-reasoning-status">
    <div class="thinking-status">
      <img
        :key="avatarSrc"
        :src="avatarSrc"
        data-agent-deployment-image="pending"
        @load="($event.target as HTMLImageElement).dataset.agentDeploymentImage = 'ready'"
        @error="($event.target as HTMLImageElement).dataset.agentDeploymentImage = 'error'"
        alt=""
        aria-hidden="true"
        class="thinking-avatar"
        :data-agent-deployment-target="deploymentSessionId || ''"
        :class="isPerson ? 'thinking-avatar--person' : isEkko ? 'thinking-avatar--animated' : 'thinking-avatar--logo'"
        :style="personAvatarStyle(agent, 'thinking')"
      >
      <div class="thinking-status-copy">
        <span class="thinking-status-label">{{ activityLabel || t('chat.thinkingInProgress') }}</span>
        <span class="thinking-status-time">{{ elapsed }}</span>
      </div>
    </div>
    <div
      v-if="!hideReasoning"
      class="live-reasoning-detail"
      :class="{ 'is-empty': !reasoningLine }"
      :data-reasoning-id="reasoningId"
    >
      <div class="live-reasoning-label">
        <span aria-hidden="true">💭</span>
        <span>{{ t('chat.thinkingLabel') }}</span>
      </div>
      <div ref="reasoningBody" class="live-reasoning-body">{{ reasoningLine }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;
@use "@/styles/person-avatar" as *;

.live-reasoning-status {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex: 0 0 78px;
  gap: calc(8px * var(--spacing-scale, 1));
  width: 100%;
  max-width: 100%;
  height: 78px;
  min-height: 78px;
  max-height: 78px;
  min-width: 0;
  overflow: hidden;
}

.thinking-status {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
  width: 100%;
  min-width: 0;
  height: 40px;
  min-height: 40px;
  max-height: 40px;
  overflow: hidden;
}

.thinking-avatar {
  width: 40px;
  height: 40px;
  border-radius: $radius-md;
  object-fit: cover;
  flex-shrink: 0;

  &--animated {
    .dark & {
      filter: brightness(1.18) contrast(1.08) saturate(1.08);
    }
  }
}

.thinking-avatar--logo {
  box-sizing: border-box;
  padding: calc(5px * var(--spacing-scale, 1));
  object-fit: contain;
  background: #fff;
}

.thinking-avatar--person { @include person-avatar(40px); }

.thinking-status-copy {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  column-gap: calc(8px * var(--spacing-scale, 1));
  row-gap: calc(2px * var(--spacing-scale, 1));
  min-width: 0;
  height: 20px;
  min-height: 20px;
  max-height: 20px;
  overflow: hidden;
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
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  line-height: var(--line-height, calc(var(--font-size-base, 14px) * 20 / 14));
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
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-variant-numeric: tabular-nums;
  line-height: var(--line-height, calc(var(--font-size-base, 14px) * 20 / 14));
  min-width: 44px;
}

.live-reasoning-detail {
  display: flex;
  align-items: center;
  flex: 0 0 30px;
  gap: calc(8px * var(--spacing-scale, 1));
  width: 520px;
  max-width: 100%;
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  min-width: 0;
  box-sizing: border-box;
  padding: calc(5px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border-radius: $radius-sm;
  background: rgba(var(--bg-main-surface-rgb), 0.82);
  color: $text-primary;
  box-shadow: inset 0 0 0 1px rgba(var(--text-primary-rgb), 0.18);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  contain: layout paint;
  transition: opacity 80ms linear;

  &.is-empty {
    opacity: 0;
    pointer-events: none;
  }
}

.live-reasoning-label {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: calc(5px * var(--spacing-scale, 1));
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 500;
}

.live-reasoning-body {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  white-space: nowrap;
  text-overflow: clip;
  color: $text-primary;
  font-size: var(--font-size-base, 14px);
  line-height: var(--line-height, calc(var(--font-size-base, 14px) * 20 / 14));
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
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

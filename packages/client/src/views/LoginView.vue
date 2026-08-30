<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, clearApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/studio/auth";
import { isDesktopShell } from "@/utils/desktop-bridge";
import { resolveLoginRedirect } from "@/utils/login-redirect";
import { useTheme } from "@/composables/useTheme";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const { activateUserTheme } = useTheme();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);
const desktopShell = isDesktopShell();

if (desktopShell) {
  // Desktop login is a recovery path. Drop stale JWTs before any background
  // request can reuse them and show an unrelated expiry notice.
  clearApiKey();
} else if (hasApiKey()) {
  router.replace(resolveLoginRedirect(route.query.redirect));
}

onMounted(async () => {
  try {
    await fetchAuthStatus();
  } catch {
    // Login remains available; the submit request will surface connection errors.
  }
});

async function handleLogin() {
  await handlePasswordLogin();
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";
  showLockResetHint.value = false;

  try {
    const session = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(session.token);
    activateUserTheme(session.userId, session.theme);
    router.replace(resolveLoginRedirect(route.query.redirect));
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
      showLockResetHint.value = true;
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="username"
          type="text"
          class="login-input"
          :placeholder="t('login.usernamePlaceholder')"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="login-input"
          :placeholder="t('login.passwordPlaceholder')"
          @keyup.enter="handleLogin"
        />

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <div v-if="showLockResetHint" class="login-lock-hint">
          <template v-if="desktopShell">
            <span>{{ t("login.desktopLockResetHint") }}</span>
          </template>
          <template v-else>
            <span>{{ t("login.lockResetHint") }}</span>
            <code>hermes-web-ui clear-login-locks --restart</code>
            <span>{{ t("login.defaultLoginResetHint") }}</span>
            <code>hermes-web-ui reset-default-login</code>
          </template>
        </div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  --login-overlay: rgba(10, 14, 23, 0.14);
  --login-surface: rgba(20, 23, 32, 0.32);
  --login-border: rgba(255, 255, 255, 0.24);
  --login-text: #ffffff;
  --login-text-muted: rgba(255, 255, 255, 0.76);
  --login-input-surface: rgba(255, 255, 255, 0.76);
  --login-input-surface-focus: rgba(255, 255, 255, 0.9);
  --login-input-text: #171923;
  --login-input-placeholder: rgba(23, 25, 35, 0.62);
  --login-focus-ring: rgba(255, 255, 255, 0.4);

  position: relative;
  min-height: calc(100 * var(--vh));
  width: 100%;
  padding: 32px 16px;
  box-sizing: border-box;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background-image: url("@/assets/login-background.webp");
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--login-overlay);
    pointer-events: none;
  }
}

.login-card {
  position: relative;
  z-index: 1;
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  box-sizing: border-box;
  border: 1px solid var(--login-border);
  border-radius: $radius-lg;
  background: var(--login-surface);
  box-shadow: 0 24px 64px rgba(7, 10, 18, 0.28);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
    --login-input-surface: rgba(255, 255, 255, 0.58);
    --login-input-surface-focus: rgba(255, 255, 255, 0.72);
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;

    .login-title,
    .login-desc {
      text-shadow: 0 2px 12px rgba(7, 10, 18, 0.86);
    }

    .login-desc {
      color: rgba(255, 255, 255, 0.94);
    }
  }
}

.login-logo {
  margin-bottom: 24px;

  img {
    display: block;
    margin: 0 auto;
    border-radius: $radius-lg;
    box-shadow: 0 8px 24px rgba(7, 10, 18, 0.24);
  }
}

.login-title {
  font-size: 26px;
  font-weight: 600;
  color: var(--login-text);
  margin: 0 0 10px;
}

.login-desc {
  font-size: 14px;
  color: var(--login-text-muted);
  margin: 0 0 12px;
  line-height: 1.6;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.login-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.54);
  border-radius: $radius-sm;
  font-size: 16px;
  color: var(--login-input-text);
  background: var(--login-input-surface);
  outline: none;
  transition:
    background-color $transition-fast,
    border-color $transition-fast,
    box-shadow $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: var(--login-input-placeholder);
  }

  &:focus {
    border-color: var(--login-text);
    background: var(--login-input-surface-focus);
    box-shadow: 0 0 0 3px var(--login-focus-ring);
  }
}

.login-error {
  font-size: 13px;
  color: #ffe0e0;
  text-align: start;
}

.login-lock-hint {
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: $radius-sm;
  background: rgba(10, 14, 23, 0.5);
  color: var(--login-text-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: start;

  code {
    display: block;
    margin-top: 4px;
    color: var(--login-text);
    font-family: $font-code;
    word-break: break-all;
  }
}

.login-btn {
  width: 100%;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: $radius-sm;
  background: rgba(255, 255, 255, 0.9);
  color: var(--login-input-text);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    box-shadow $transition-fast;

  &:hover {
    background: var(--login-text);
  }

  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--login-focus-ring);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

@media (min-width: 1024px) {
  .login-view {
    --login-overlay: rgba(10, 14, 23, 0.14);
    --login-surface: rgba(20, 23, 32, 0.74);

    align-items: stretch;
    justify-content: flex-start;
    padding: 0;
  }

  .login-card {
    width: clamp(380px, 30vw, 420px);
    max-width: none;
    min-height: calc(100 * var(--vh));
    padding: 56px 48px;
    border-width: 0 1px 0 0;
    border-radius: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    box-shadow: 24px 0 64px rgba(7, 10, 18, 0.24);
  }
}
</style>

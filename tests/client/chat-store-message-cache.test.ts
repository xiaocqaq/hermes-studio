// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { resumeSession, onSessionActivity } from '@/api/hermes/chat'
import { fetchSessionMessagesPage, fetchSessions } from '@/api/hermes/sessions'
import { readCachedSession, writeCachedSession } from '@/utils/hermes/message-cache'

vi.mock('@/api/hermes/sessions', () => ({
  archiveSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  deleteSession: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
}))

vi.mock('@/api/hermes/chat', () => {
  // Inlined rather than built by a helper: this factory runs while the store's
  // imports are still being evaluated, before this file's own bindings exist.
  const row = (id: number, role: string, content: string) => ({
    id,
    session_id: 'session-a',
    role,
    content,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    run_marker: null,
    timestamp: 1_700_000_000 + id,
    token_count: null,
    finish_reason: null,
    reasoning: null,
  })
  return {
    startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
    resumeSession: vi.fn((sessionId: string, cb: (data: any) => void) => {
      cb({
        session_id: sessionId,
        isWorking: false,
        messages: [row(1, 'user', 'from resume'), row(2, 'assistant', 'resume reply')],
        messageLoadedCount: 2,
        messageTotal: 2,
        hasMoreBefore: false,
      })
      return { emit: vi.fn() }
    }),
    registerSessionHandlers: vi.fn(),
    unregisterSessionHandlers: vi.fn(),
    getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
    respondToolApproval: vi.fn(),
    respondClarify: vi.fn(),
    onPeerUserMessage: vi.fn(() => vi.fn()),
    onSessionCommand: vi.fn(() => vi.fn()),
    onSessionTitleUpdated: vi.fn(() => vi.fn()),
    onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
    onSessionSettingsUpdated: vi.fn(() => vi.fn()),
    onSessionActivity: vi.fn(() => vi.fn()),
  }
})

// jsdom has no IndexedDB, so the real module always misses. Mock it so the store's
// cache branches are exercised deterministically.
vi.mock('@/utils/hermes/message-cache', () => ({
  CACHE_SCHEMA_VERSION: 1,
  CACHE_TTL_MS: 24 * 60 * 60 * 1000,
  CACHE_MAX_SESSIONS: 30,
  cacheKey: (profile: string | null | undefined, sessionId: string) => `${profile || 'default'}::${sessionId}`,
  isMessageCacheAvailable: () => true,
  readCachedSession: vi.fn(async () => null),
  writeCachedSession: vi.fn(async () => undefined),
  deleteCachedSession: vi.fn(async () => undefined),
  clearMessageCache: vi.fn(async () => undefined),
  pruneMessageCache: vi.fn(async () => undefined),
  stripAttachmentFiles: (messages: unknown[]) => messages,
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/hermes/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/utils/completion-notification', () => ({
  showCompletionNotification: vi.fn(),
}))

vi.mock('@/utils/session-sync', () => ({
  subscribeSessionSync: vi.fn(() => vi.fn()),
  publishSessionSync: vi.fn(),
}))

function rawMessage(id: number, role: 'user' | 'assistant', content: string) {
  return {
    id,
    session_id: 'session-a',
    role,
    content,
    tool_call_id: null,
    tool_calls: null,
    tool_name: null,
    run_marker: null,
    timestamp: 1_700_000_000 + id,
    token_count: null,
    finish_reason: null,
    reasoning: null,
  }
}

function summary(messageCount: number) {
  return {
    id: 'session-a',
    profile: 'default',
    source: 'cli',
    title: 'session-a',
    preview: '',
    started_at: 1_700_000_000,
    ended_at: null,
    last_active: 1_700_000_100,
    message_count: messageCount,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    model: 'gpt-test',
    provider: 'test',
  }
}

/** Two cached rows, mapped exactly the way `mapHermesMessages` would map ids 1 and 2. */
function snapshot(messageTotal = 2) {
  return {
    key: 'default::session-a',
    schemaVersion: 1,
    savedAt: Date.now(),
    sessionId: 'session-a',
    profile: 'default',
    messages: [
      { id: '1', role: 'user', content: 'cached question', timestamp: 1_700_000_001_000 },
      { id: '2', role: 'assistant', content: 'cached answer', timestamp: 1_700_000_002_000 },
    ],
    loadedMessageCount: 2,
    messageTotal,
    hasMoreBefore: false,
  } as any
}

async function loadStoreWithSession(messageCount: number) {
  vi.mocked(fetchSessions)
    .mockResolvedValueOnce([summary(messageCount)] as any)
    .mockResolvedValueOnce([])
  const store = useChatStore()
  await store.loadSessions()
  return store
}

describe('chat store local message cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    vi.mocked(readCachedSession).mockResolvedValue(null)
  })

  it('renders an idle session from the snapshot without any resume or fetch', async () => {
    vi.mocked(readCachedSession).mockResolvedValue(snapshot())
    const store = await loadStoreWithSession(2)

    // loadSessions auto-selects the only session, which already took the cache path.
    expect(resumeSession).not.toHaveBeenCalled()
    expect(fetchSessionMessagesPage).not.toHaveBeenCalled()
    expect(store.activeSession?.messages.map(m => m.content)).toEqual([
      'cached question',
      'cached answer',
    ])
  })

  it('fetches only the tail when the server reports more messages', async () => {
    vi.mocked(readCachedSession).mockResolvedValue(snapshot(2))
    vi.mocked(fetchSessionMessagesPage).mockResolvedValue({
      session: { id: 'session-a', title: 'session-a' },
      messages: [rawMessage(2, 'assistant', 'cached answer'), rawMessage(3, 'user', 'new question')],
      total: 3,
      offset: 0,
      limit: 21,
      hasMore: true,
    } as any)

    const store = await loadStoreWithSession(3)

    expect(resumeSession).not.toHaveBeenCalled()
    // offset 0 is the newest slice: the server pages with ORDER BY id DESC.
    expect(fetchSessionMessagesPage).toHaveBeenCalledWith('session-a', 0, 21, 'default')
    const ids = store.activeSession?.messages.map(m => m.id)
    expect(ids).toEqual(['1', '2', '3'])
    expect(new Set(ids).size).toBe(ids?.length)
    expect(store.activeSession?.messageTotal).toBe(3)
  })

  it('falls back to a full resume when the server has fewer rows than the snapshot', async () => {
    vi.mocked(readCachedSession).mockResolvedValue(snapshot(2))
    vi.mocked(fetchSessionMessagesPage).mockResolvedValue({
      session: { id: 'session-a', title: 'session-a' },
      messages: [rawMessage(9, 'assistant', 'post-compression summary')],
      total: 1,
      offset: 0,
      limit: 21,
      hasMore: false,
    } as any)

    const store = await loadStoreWithSession(3)

    expect(resumeSession).toHaveBeenCalled()
    expect(store.activeSession?.messages.map(m => m.content)).toEqual([
      'from resume',
      'resume reply',
    ])
  })

  it('resumes normally when no usable snapshot exists', async () => {
    const store = await loadStoreWithSession(2)

    expect(readCachedSession).toHaveBeenCalledWith('default', 'session-a')
    expect(resumeSession).toHaveBeenCalled()
    expect(store.activeSession?.messages).toHaveLength(2)
  })

  it('snapshots the session once the debounce window elapses', async () => {
    vi.useFakeTimers()
    try {
      await loadStoreWithSession(2)
      expect(writeCachedSession).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(writeCachedSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-a', messageTotal: 2 }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('pullLatestMessages reports an update after appending the new tail', async () => {
    vi.mocked(readCachedSession).mockResolvedValue(snapshot(2))
    const store = await loadStoreWithSession(2)

    vi.mocked(fetchSessions)
      .mockResolvedValueOnce([summary(3)] as any)
      .mockResolvedValueOnce([])
    vi.mocked(fetchSessionMessagesPage).mockResolvedValue({
      session: { id: 'session-a', title: 'session-a' },
      messages: [rawMessage(3, 'assistant', 'reply from telegram')],
      total: 3,
      offset: 0,
      limit: 20,
      hasMore: true,
    } as any)

    const result = await store.pullLatestMessages()

    expect(result).toBe('updated')
    expect(store.activeSession?.messages.at(-1)?.content).toBe('reply from telegram')
    expect(store.isPullingMessages).toBe(false)
  })

  it('resumes when a run starts elsewhere so the cached session rejoins the room', async () => {
    vi.mocked(readCachedSession).mockResolvedValue(snapshot())
    const store = await loadStoreWithSession(2)

    expect(store.activeSessionId).toBe('session-a')
    expect(resumeSession).not.toHaveBeenCalled()

    // The store registers this handler at setup; `session.activity` is the only
    // hint we get for a run started from the CLI / Telegram / another tab.
    const handler = vi.mocked(onSessionActivity).mock.calls[0][0]
    handler({ event: 'session.activity', session_id: 'session-a', status: 'running' } as any)

    expect(resumeSession).toHaveBeenCalledWith(
      'session-a',
      expect.any(Function),
      'default',
      expect.anything(),
    )
  })
})

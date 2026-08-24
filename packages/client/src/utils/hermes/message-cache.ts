import type { Attachment, Message } from '@/stores/hermes/chat'

/**
 * Local (IndexedDB) cache for per-session chat messages.
 *
 * Why this exists: switching sessions, re-focusing the tab and reconnecting the
 * socket each replay a full `resume` page (up to RESUME_MESSAGE_PAGE_LIMIT = 150
 * messages) from the server. On metered connections that is the dominant cost of
 * simply reading an old conversation. With a local snapshot the client can render
 * an idle session without any network at all, and top up only the newly arrived
 * tail through the paginated REST endpoint.
 *
 * localStorage is deliberately not used here — message pages blew past the quota
 * in the past (see `recoverStorageQuota` in the chat store, which still purges the
 * abandoned `hermes_session_msgs_v1_` keys). IndexedDB has a far larger budget and
 * stores structured values without a JSON round-trip on read.
 *
 * Everything in this module is best effort: any failure is treated as a cache miss
 * so the caller silently falls back to the existing `resume` path.
 */

const DB_NAME = 'hermes-chat-cache'
const DB_VERSION = 1
const STORE_NAME = 'sessionMessages'
const SAVED_AT_INDEX = 'savedAt'

/** Snapshots older than this are discarded and re-fetched from the server. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Bump when the snapshot shape changes so stale records are dropped, not misread. */
export const CACHE_SCHEMA_VERSION = 1
/** LRU bound — keep the most recently written snapshots, drop the rest. */
export const CACHE_MAX_SESSIONS = 30

export interface CachedSessionSnapshot {
  /** `${profile}::${sessionId}` — the object store key. */
  key: string
  schemaVersion: number
  savedAt: number
  sessionId: string
  profile: string
  messages: Message[]
  /** Raw server row count backing `messages` (not `messages.length`, which is post-mapping). */
  loadedMessageCount: number
  /** Server-side total row count for the session at snapshot time. */
  messageTotal: number
  hasMoreBefore: boolean
  title?: string
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  model?: string
  provider?: string
  reasoningEffort?: string
  workspace?: string | null
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  parentTitle?: string | null
  parentLastMessage?: string | null
  parentLastMessageRole?: string | null
}

export function cacheKey(profile: string | null | undefined, sessionId: string): string {
  // Sessions are scoped per profile server-side, so the profile has to be part of
  // the key or a profile switch would resurrect another profile's transcript.
  return `${profile || 'default'}::${sessionId}`
}

let dbPromise: Promise<IDBDatabase | null> | null = null
let disabled = false

/**
 * Synchronous guard so callers can skip the cache path — and the `await` it costs —
 * entirely when there is no IndexedDB (jsdom, SSR, private-mode lockdowns).
 */
export function isMessageCacheAvailable(): boolean {
  return !disabled && typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (disabled) return Promise.resolve(null)
  if (typeof indexedDB === 'undefined') {
    // jsdom / SSR / private-mode browsers without IndexedDB — cache stays off.
    disabled = true
    return Promise.resolve(null)
  }
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      disabled = true
      resolve(null)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        store.createIndex(SAVED_AT_INDEX, 'savedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      disabled = true
      resolve(null)
    }
    request.onblocked = () => resolve(null)
  })

  return dbPromise
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void) => void,
  fallback: T,
): Promise<T> {
  return openDb().then(db => {
    if (!db) return fallback
    return new Promise<T>((resolve) => {
      let settled = false
      const settle = (value: T) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        const tx = db.transaction(STORE_NAME, mode)
        tx.onerror = () => settle(fallback)
        tx.onabort = () => settle(fallback)
        run(tx.objectStore(STORE_NAME), settle)
        if (mode === 'readwrite') tx.oncomplete = () => settle(fallback)
      } catch {
        settle(fallback)
      }
    })
  }).catch(() => fallback)
}

/**
 * Drop the `file: File` handle from attachments — File objects are not structured
 * cloneable across a page reload and the UI only needs name/type/size/url to
 * render a persisted attachment.
 */
export function stripAttachmentFiles(messages: Message[]): Message[] {
  return messages.map(message => {
    if (!message.attachments?.length) return message
    const attachments: Attachment[] = message.attachments.map(attachment => {
      if (!attachment.file) return attachment
      const { file: _file, ...rest } = attachment
      return rest
    })
    return { ...message, attachments }
  })
}

/**
 * Reactive proxies and stray non-cloneable values (functions on tool payloads,
 * etc.) would abort the whole IndexedDB transaction, so serialize defensively.
 * Returns null when the snapshot cannot be represented at all.
 */
function toStorableSnapshot(snapshot: CachedSessionSnapshot): CachedSessionSnapshot | null {
  try {
    return JSON.parse(JSON.stringify({
      ...snapshot,
      messages: stripAttachmentFiles(snapshot.messages),
    })) as CachedSessionSnapshot
  } catch {
    return null
  }
}

export async function readCachedSession(
  profile: string | null | undefined,
  sessionId: string,
): Promise<CachedSessionSnapshot | null> {
  const key = cacheKey(profile, sessionId)
  const record = await withStore<CachedSessionSnapshot | null>('readonly', (store, resolve) => {
    const request = store.get(key)
    request.onsuccess = () => resolve((request.result as CachedSessionSnapshot | undefined) ?? null)
    request.onerror = () => resolve(null)
  }, null)

  if (!record) return null
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(record.messages)) {
    void deleteCachedSession(profile, sessionId)
    return null
  }
  if (!Number.isFinite(record.savedAt) || Date.now() - record.savedAt > CACHE_TTL_MS) {
    void deleteCachedSession(profile, sessionId)
    return null
  }
  return record
}

export async function writeCachedSession(snapshot: CachedSessionSnapshot): Promise<void> {
  const storable = toStorableSnapshot(snapshot)
  if (!storable) return
  await withStore<void>('readwrite', (store) => {
    store.put(storable)
  }, undefined)
}

export async function deleteCachedSession(
  profile: string | null | undefined,
  sessionId: string,
): Promise<void> {
  const key = cacheKey(profile, sessionId)
  await withStore<void>('readwrite', (store) => {
    store.delete(key)
  }, undefined)
}

export async function clearMessageCache(): Promise<void> {
  await withStore<void>('readwrite', (store) => {
    store.clear()
  }, undefined)
}

/** Drop expired snapshots, then trim the oldest until CACHE_MAX_SESSIONS remain. */
export async function pruneMessageCache(): Promise<void> {
  const cutoff = Date.now() - CACHE_TTL_MS
  await withStore<void>('readwrite', (store) => {
    // The savedAt index walks oldest-first, so survivors accumulate in eviction order.
    const survivors: IDBValidKey[] = []
    const request = store.index(SAVED_AT_INDEX).openKeyCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        if (Number(cursor.key) < cutoff) store.delete(cursor.primaryKey)
        else survivors.push(cursor.primaryKey)
        cursor.continue()
        return
      }
      const excess = survivors.length - CACHE_MAX_SESSIONS
      for (let i = 0; i < excess; i++) store.delete(survivors[i])
    }
  }, undefined)
}

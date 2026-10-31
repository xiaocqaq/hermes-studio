import { getActiveProfileName, getApiKey } from '../client'
import { deploymentUrl } from '@/utils/deployment-url'

/** Chunk size fallback when the server does not advertise one. */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

export interface ChunkedUploadResult {
  name: string
  path: string
}

export interface ChunkedUploadOptions {
  profile?: string | null
  signal?: AbortSignal
  /** Called with a 0-100 completion percentage. */
  onProgress?: (percent: number) => void
  /** Called once the server opened an upload session (used to abort it later). */
  onSessionId?: (id: string) => void
}

interface UploadSessionInfo {
  id: string
  nextOffset: number
  maxChunkBytes: number
}

function uploadId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function authHeaders(profile?: string | null): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getApiKey()
  if (token) headers.Authorization = `Bearer ${token}`
  const name = (profile || getActiveProfileName() || '').trim()
  if (name) headers['X-Hermes-Profile'] = name
  return headers
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as { error?: string }
    if (body?.error) return body.error
  } catch {
    // ignore non-JSON error bodies
  }
  return `${fallback} (${res.status})`
}

function putChunk(
  url: string,
  headers: Record<string, string>,
  body: Blob,
  options: { signal?: AbortSignal; onProgress?: (loaded: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url, true)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return }
      let message = `Upload failed (${xhr.status})`
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string }
        if (parsed?.error) message = parsed.error
      } catch {
        // keep the status-based message
      }
      reject(new Error(message))
    }
    xhr.onerror = () => reject(new Error('Upload failed (network error)'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
    xhr.send(body)
  })
}

/**
 * Upload a file in ordered chunks so large attachments never have to sit in the
 * server process memory. The server keeps a temporary .part file per session and
 * promotes it into the profile upload directory on completion.
 */
export async function uploadFileInChunks(
  file: File,
  options: ChunkedUploadOptions = {},
): Promise<ChunkedUploadResult> {
  const headers = authHeaders(options.profile)
  if (file.size === 0) {
    // Empty files still deserve a stored path; send one 0-byte part and complete.
    const session = await openSession(file, headers, options)
    return completeSession(session.id, headers, options)
  }
  const id = uploadId()
  const initRes = await fetch(deploymentUrl('/api/studio/app-uploads'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: file.name, size: file.size }),
    signal: options.signal,
  })
  if (!initRes.ok) throw new Error(await errorMessage(initRes, 'Upload failed'))
  const session = await initRes.json() as UploadSessionInfo
  options.onSessionId?.(session.id)
  const chunkSize = Math.max(1, Math.min(session.maxChunkBytes || DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES))
  let offset = Math.max(0, Number(session.nextOffset) || 0)
  if (offset > 0) {
    // A fresh upload id always starts at zero; guard against a stale session.
    offset = 0
  }
  options.onProgress?.(0)
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size)
    const blob = file.slice(offset, end)
    const base = offset
    await putChunk(
      `${deploymentUrl(`/api/studio/app-uploads/${encodeURIComponent(session.id)}/chunks`)}?offset=${offset}`,
      headers,
      blob,
      {
        signal: options.signal,
        onProgress: (loaded) => {
          const percent = Math.min(99, Math.round(((base + loaded) / file.size) * 100))
          options.onProgress?.(percent)
        },
      },
    )
    offset = end
  }
  const result = await completeSession(session.id, headers, options)
  options.onProgress?.(100)
  return result
}

async function openSession(
  file: File,
  headers: Record<string, string>,
  options: ChunkedUploadOptions,
): Promise<UploadSessionInfo> {
  const res = await fetch(deploymentUrl('/api/studio/app-uploads'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: uploadId(), name: file.name, size: file.size }),
    signal: options.signal,
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Upload failed'))
  return await res.json() as UploadSessionInfo
}

async function completeSession(
  id: string,
  headers: Record<string, string>,
  options: ChunkedUploadOptions,
): Promise<ChunkedUploadResult> {
  const res = await fetch(deploymentUrl(`/api/studio/app-uploads/${encodeURIComponent(id)}/complete`), {
    method: 'POST',
    headers,
    signal: options.signal,
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'Upload failed'))
  const body = await res.json() as { files?: ChunkedUploadResult[] }
  const file = body?.files?.[0]
  if (!file?.path) throw new Error('Upload failed (empty response)')
  return file
}

/** Best-effort cleanup for an upload session the user abandoned. */
export async function abortChunkedUpload(id: string, profile?: string | null): Promise<void> {
  try {
    await fetch(deploymentUrl(`/api/studio/app-uploads/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: authHeaders(profile),
    })
  } catch {
    // ignore: the session expires on its own
  }
}

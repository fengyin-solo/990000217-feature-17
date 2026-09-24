import api from '../api'

// Persistent save-feedback support.
//
// Every write (create/update/delete) gets:
//  - an Idempotency-Key header so a retried request after token expiry,
//    timeout or double submit replays the server-side outcome;
//  - a "pending op" persisted to localStorage, so re-entering the editor
//    after a crash/navigation can reconcile whether the write landed.
//
// Editor drafts are autosaved separately under `blog_draft_<key>`.

const PENDING_KEY = 'blog_pending_ops'
const DRAFT_PREFIX = 'blog_draft_'
const MAX_PENDING = 20

export function generateIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID()
  }
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function readPending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-MAX_PENDING)))
}

export function savePendingOp(op) {
  const list = readPending().filter(item => item.idempotencyKey !== op.idempotencyKey)
  list.push({ ...op, savedAt: Date.now() })
  writePending(list)
}

export function removePendingOp(idempotencyKey) {
  writePending(readPending().filter(op => op.idempotencyKey !== idempotencyKey))
}

export function getPendingOps(filter = {}) {
  return readPending()
    .filter(op => {
      if (filter.articleId !== undefined && op.articleId !== filter.articleId) return false
      if (filter.method && op.method !== filter.method) return false
      if (filter.scope && op.scope !== filter.scope) return false
      return true
    })
    .sort((a, b) => a.savedAt - b.savedAt)
}

// Drafts -----------------------------------------------------------------

export function draftKey(articleId) {
  return `${DRAFT_PREFIX}${articleId || 'new'}`
}

export function saveDraft(articleId, draft) {
  try {
    localStorage.setItem(draftKey(articleId), JSON.stringify({ ...draft, savedAt: Date.now() }))
  } catch {
    // storage full / unavailable — drafts are best effort
  }
}

export function loadDraft(articleId) {
  try {
    const raw = localStorage.getItem(draftKey(articleId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearDraft(articleId) {
  localStorage.removeItem(draftKey(articleId))
}

// Error classification ---------------------------------------------------

export function isAuthError(error) {
  return !!error.response && [401, 403].includes(error.response.status)
}

// The request may have succeeded on the server even though the client saw
// a failure (timeout, network drop, 5xx, expired token). These must be
// reconciled by replaying the same idempotency key, never silently retried
// as a brand-new write.
export function isUncertainError(error) {
  if (error.code === 'ECONNABORTED' || error.message === 'Network Error') return true
  if (!error.response) return true
  return error.response.status >= 500
}

// Replay a persisted write using its stored idempotency key. The server
// either performs the write once (first arrival) or replays the captured
// response (duplicate), so this never double-writes.
export async function replayPendingOp(op) {
  const headers = { 'Idempotency-Key': op.idempotencyKey }
  let response
  if (op.method === 'POST') {
    response = await api.post(op.path, op.data || {}, { headers })
  } else if (op.method === 'PUT') {
    response = await api.put(op.path, op.data || {}, { headers })
  } else if (op.method === 'DELETE') {
    response = await api.delete(op.path, { headers })
  } else {
    throw new Error(`Unsupported pending method: ${op.method}`)
  }
  return response
}

import api from '../api'

/**
 * Write recovery / idempotency support for article create / update / delete.
 *
 * Problems this solves:
 *  - A write whose response is lost (timeout, network drop, expired token)
 *    leaves the user unsure whether it succeeded. We persist a "pending
 *    write" record in localStorage and can reconcile it against the server
 *    (via Idempotency-Key) without ever performing the write twice.
 *  - Duplicate submissions (double click, retry after timeout) replay the
 *    first outcome server-side.
 *  - Re-entering the editor restores the correct state by resolving any
 *    pending write first.
 */

const STORAGE_KEY = 'blog_pending_writes'

export function newIdempotencyKey() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID()
  }
  return `write-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function writeAll(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

export function getPending(scope) {
  return readAll()[scope] || null
}

export function listPending() {
  return Object.values(readAll())
}

export function savePending(record) {
  const all = readAll()
  all[record.scope] = record
  writeAll(all)
}

export function removePending(scope) {
  const all = readAll()
  if (all[scope]) {
    delete all[scope]
    writeAll(all)
  }
}

// True when a failure could mean the write actually succeeded server-side.
export function isAmbiguousError(error) {
  if (!error.response) return true // timeout / network error / no response
  const status = error.response.status
  return status === 401 || status === 403
}

export class AmbiguousWriteError extends Error {
  constructor(record, cause) {
    super('写入结果未知')
    this.name = 'AmbiguousWriteError'
    this.record = record
    this.cause = cause
  }
}

/**
 * Ask the server whether a previously submitted write completed.
 * @returns {Promise<{completed: boolean, status?: number, response?: any}>}
 */
export async function checkWriteStatus(idempotencyKey) {
  try {
    const { data } = await api.get(`/idempotency/${idempotencyKey}`)
    return { completed: true, status: data.status, response: data.response }
  } catch (error) {
    if (error.response?.status === 404) {
      return { completed: false }
    }
    // Auth / network problems: we simply cannot tell yet.
    throw error
  }
}

/**
 * Resolve a pending write for a scope (used when re-entering a page).
 * @returns {Promise<{status: 'completed'|'not_found'|'uncertain', pending?: object, response?: any}>}
 */
export async function resolvePending(scope) {
  const pending = getPending(scope)
  if (!pending) return { status: 'not_found' }

  try {
    const result = await checkWriteStatus(pending.idempotencyKey)
    if (result.completed) {
      removePending(scope)
      return { status: 'completed', pending, response: result.response }
    }
    // Server has no record: the request never reached a completed write.
    removePending(scope)
    return { status: 'not_found', pending }
  } catch {
    return { status: 'uncertain', pending }
  }
}

function payloadEqual(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {})
}

/**
 * Submit a write idempotently.
 *
 * @param {object} options
 * @param {string} options.scope       e.g. 'create' | 'edit:3' | 'delete:3'
 * @param {string} options.method      'post' | 'put' | 'delete'
 * @param {string} options.url         endpoint under /api
 * @param {object} [options.payload]   request body
 * @returns {Promise<{data: object, replayed: boolean}>}
 * @throws {AmbiguousWriteError} when the outcome cannot be determined;
 *         the pending record is kept for later reconciliation.
 */
export async function submitWrite({ scope, method, url, payload = {} }) {
  let pending = getPending(scope)
  let idempotencyKey

  if (pending) {
    // A previous attempt ended ambiguously — reconcile before writing again.
    try {
      const result = await checkWriteStatus(pending.idempotencyKey)
      if (result.completed) {
        removePending(scope)
        return { data: result.response, replayed: true }
      }
      // Not completed: reuse the key only when retrying the exact same
      // payload; a changed edit gets a fresh key.
      if (payloadEqual(pending.payload, payload)) {
        idempotencyKey = pending.idempotencyKey
      } else {
        idempotencyKey = newIdempotencyKey()
        pending = null
      }
    } catch (error) {
      throw new AmbiguousWriteError(pending, error)
    }
  } else {
    idempotencyKey = newIdempotencyKey()
  }

  const record = {
    scope,
    method,
    url,
    payload,
    idempotencyKey,
    at: new Date().toISOString()
  }
  savePending(record)

  try {
    const { data } = await api({
      method,
      url,
      data: payload,
      headers: { 'Idempotency-Key': idempotencyKey }
    })
    removePending(scope)
    const replayed = data?.meta?.replayed === true
    return { data, replayed }
  } catch (error) {
    if (isAmbiguousError(error)) {
      // Keep the pending record; the write may have succeeded.
      throw new AmbiguousWriteError(record, error)
    }
    // Definitive rejection (validation / version conflict / 404): no need
    // to reconcile later.
    removePending(scope)
    throw error
  }
}

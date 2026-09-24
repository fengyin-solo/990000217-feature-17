const crypto = require('crypto');
const { getDb } = require('../db/init');

const TTL_MS = 24 * 60 * 60 * 1000;

// Idempotency for write requests.
//
// A client that is unsure whether a write succeeded (request timed out,
// token expired after the write, double click, retried after re-login)
// resends the request carrying the same `Idempotency-Key` header. The
// first response is captured and replayed verbatim, so the write is
// performed at most once and the caller can always learn the outcome.
//
// Reusing a key with a different request payload is rejected with 409
// IDEMPOTENCY_KEY_MISMATCH, so a single key cannot mutate twice.
function idempotent(req, res, next) {
  const key = req.get('Idempotency-Key') || req.get('X-Idempotency-Key');
  if (!key) {
    return next();
  }

  if (!/^[\w.\-:]{1,128}$/.test(key)) {
    return res.status(400).json({ error: 'Invalid idempotency key' });
  }

  const db = getDb();
  const nowIso = () => new Date().toISOString();

  db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(nowIso());

  const method = req.method;
  const routePath = req.originalUrl.split('?')[0];
  const requestHash = crypto
    .createHash('sha256')
    .update(method)
    .update('\n')
    .update(routePath)
    .update('\n')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');

  const stored = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key);
  if (stored) {
    if (stored.expires_at <= nowIso()) {
      db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
    } else if (
      stored.request_hash !== requestHash ||
      (stored.username && req.user && stored.username !== req.user.username)
    ) {
      // Same key reused with a different payload, or by a different user
      return res.status(409).json({
        error: 'Idempotency key was already used with a different request',
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });
    } else {
      res.set('Idempotent-Replay', 'true');
      return res.status(stored.status_code).json(JSON.parse(stored.response_body));
    }
  }

  // Capture whatever the route responds (except unrecoverable server errors,
  // which must remain retryable). `res.json` is called after status() sets
  // res.statusCode, so both are available here.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      const now = Date.now();
      db.prepare(`
        INSERT OR REPLACE INTO idempotency_keys
          (key, username, method, path, request_hash, status_code,
           response_body, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key,
        (req.user && req.user.username) || null,
        method,
        routePath,
        requestHash,
        res.statusCode,
        JSON.stringify(body),
        new Date(now).toISOString(),
        new Date(now + TTL_MS).toISOString()
      );
    }
    res.set('Idempotent-Replay', 'false');
    return originalJson(body);
  };

  next();
}

module.exports = { idempotent, IDEMPOTENCY_TTL_MS: TTL_MS };

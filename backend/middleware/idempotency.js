const crypto = require('crypto');
const { getDb } = require('../db/init');

const IDEMPOTENCY_HEADER = 'idempotency-key';

// Hash the request body so the same key with a *different* payload can be
// rejected (409) instead of silently replaying an unrelated write.
function hashBody(body) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(body || {}))
    .digest('hex');
}

function findRecord(key, method, path) {
  return getDb()
    .prepare(
      `SELECT * FROM idempotency_records
       WHERE idempotency_key = ? AND method = ? AND path = ?`
    )
    .get(key, method, path);
}

/**
 * Wrap a write handler with idempotency support.
 *
 * Usage: router.post('/', authenticateToken, withIdempotency((req, res) => { ... }))
 * The inner handler should use res.respond(status, body) instead of
 * res.status(...).json(...); only responses sent through respond() are stored
 * and replayed. Successful 2xx outcomes are cached; 4xx validation failures
 * are not, so clients may fix the payload and retry with the same key.
 */
function withIdempotency(handler) {
  return (req, res) => {
    const key = req.headers[IDEMPOTENCY_HEADER];

    // No key: behave exactly as before (backward compatible).
    if (!key) {
      res.respond = (status, body) => res.status(status).json(body);
      return handler(req, res);
    }

    const db = getDb();
    const method = req.method;
    const requestPath = req.originalUrl.split('?')[0];
    const requestHash = hashBody(req.body);

    let record;
    try {
      record = findRecord(key, method, requestPath);
    } catch (err) {
      console.error('Idempotency lookup failed:', err);
      return res.status(500).json({ error: 'Failed to process request' });
    }

    if (record) {
      if (record.request_hash !== requestHash) {
        return res.status(409).json({
          error: 'Idempotency-Key was already used with a different request body',
          code: 'IDEMPOTENCY_KEY_REUSED'
        });
      }

      // Replay the original outcome — the write is never executed twice.
      res.setHeader('Idempotency-Replayed', 'true');
      const body = JSON.parse(record.response_body);
      if (body && typeof body === 'object') {
        body.meta = { ...(body.meta || {}), replayed: true };
      }
      return res.status(record.response_status).json(body);
    }

    res.respond = (status, body) => {
      // Only cache definitive successful outcomes.
      if (status >= 200 && status < 300) {
        try {
          db.prepare(
            `INSERT INTO idempotency_records
               (idempotency_key, method, path, request_hash, response_status, response_body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            key,
            method,
            requestPath,
            requestHash,
            status,
            JSON.stringify(body),
            new Date().toISOString()
          );
        } catch (err) {
          // UNIQUE race: another concurrent request with the same key won.
          const winner = findRecord(key, method, requestPath);
          if (winner && winner.request_hash === requestHash) {
            res.setHeader('Idempotency-Replayed', 'true');
            const replayed = JSON.parse(winner.response_body);
            if (replayed && typeof replayed === 'object') {
              replayed.meta = { ...(replayed.meta || {}), replayed: true };
            }
            return res.status(winner.response_status).json(replayed);
          }
          throw err;
        }
      }
      return res.status(status).json(body);
    };

    return handler(req, res);
  };
}

// Look up a previously completed write after an ambiguous failure
// (expired token, timeout, network drop) without repeating the write.
function getIdempotencyStatus(req, res) {
  const key = req.params.key;
  try {
    const record = getDb()
      .prepare(
        `SELECT method, path, response_status, response_body, created_at
         FROM idempotency_records
         WHERE idempotency_key = ?`
      )
      .get(key);

    if (!record) {
      return res.status(404).json({
        error: 'No completed request found for this Idempotency-Key',
        code: 'IDEMPOTENCY_NOT_FOUND'
      });
    }

    return res.json({
      key,
      method: record.method,
      path: record.path,
      status: record.response_status,
      completedAt: record.created_at,
      response: JSON.parse(record.response_body)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to look up request status' });
  }
}

module.exports = { withIdempotency, getIdempotencyStatus };

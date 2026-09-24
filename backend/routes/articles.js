const express = require('express');
const { getDb } = require('../db/init');
const { authenticateToken } = require('../middleware/auth');
const { withIdempotency, getIdempotencyStatus } = require('../middleware/idempotency');

const router = express.Router();

const WRITABLE_FIELDS = ['title', 'body', 'summary', 'tags'];

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.join(',');
  return tags || '';
}

function formatArticle(article) {
  if (!article) return null;
  return {
    ...article,
    tags: article.tags ? article.tags.split(',').map(t => t.trim()).filter(Boolean) : []
  };
}

// A minimal snapshot of an article used for recovery / conflict responses.
function articleSnapshot(article) {
  if (!article) return null;
  return {
    id: article.id,
    title: article.title,
    body: article.body,
    summary: article.summary,
    tags: article.tags ? article.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    version: article.version,
    updated_at: article.updated_at
  };
}

// Compare only the writable fields and report what actually changed.
function diffArticles(before, next) {
  const changed = [];
  for (const field of WRITABLE_FIELDS) {
    if (field === 'tags') {
      const beforeTags = articleSnapshot(before).tags;
      const nextTags = formatArticle({ tags: next.tagsStr }).tags;
      if (JSON.stringify(beforeTags) !== JSON.stringify(nextTags)) {
        changed.push('tags');
      }
    } else if (String(before[field] ?? '') !== String(next[field] ?? '')) {
      changed.push(field);
    }
  }
  return changed;
}

// Feedback envelope attached to every write response. The original article
// fields stay at the top level for backward compatibility.
function writeMeta({ action, article, previous, changed, replayed }) {
  return {
    action,
    changed: changed || [],
    previous: previous === undefined ? null : articleSnapshot(previous),
    version: article ? article.version : null,
    updatedAt: article ? article.updated_at : null,
    // True when this response was served from the idempotency cache.
    replayed: !!replayed
  };
}

// GET /api/articles - List articles with pagination, tag filter and search
router.get('/', (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const tag = req.query.tag || null;
  const search = req.query.search || null;
  const offset = (page - 1) * limit;

  let countQuery, articlesQuery;
  let params = [];
  let countParams = [];
  let whereClauses = [];

  if (tag) {
    whereClauses.push(`',' || tags || ',' LIKE ?`);
    params.push(`%,${tag},%`);
    countParams.push(`%,${tag},%`);
  }

  if (search) {
    whereClauses.push(`(title LIKE ? OR summary LIKE ?)`);
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm);
    countParams.push(searchTerm, searchTerm);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  countQuery = `SELECT COUNT(*) as total FROM articles ${whereSql}`;
  articlesQuery = `SELECT id, title, summary, tags, version, created_at, updated_at FROM articles ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const { total } = db.prepare(countQuery).get(...countParams);
    const articles = db.prepare(articlesQuery).all(...params);

    const parsedArticles = articles.map(article => formatArticle(article));

    res.json({
      articles: parsedArticles,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// GET /api/articles/:id - Get single article
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.setHeader('X-Article-Version', String(article.version));
    res.json(formatArticle(article));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// POST /api/articles - Create article (requires auth)
// Optional Idempotency-Key header makes duplicate submissions replay the
// first result instead of inserting a second article.
router.post('/', authenticateToken, withIdempotency((req, res) => {
  const db = getDb();
  const { title, body, summary, tags } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    const tagsStr = parseTags(tags);
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO articles (title, body, summary, tags, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, body, summary || '', tagsStr, 1, now, now);

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(result.lastInsertRowid);

    return res.respond(201, {
      ...formatArticle(article),
      meta: writeMeta({
        action: 'created',
        article,
        previous: null,
        changed: WRITABLE_FIELDS
      })
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to create article' });
  }
}));

// PUT /api/articles/:id - Update article (requires auth)
// Optional body.version enables optimistic concurrency: if another editor has
// saved since the article was loaded, a stale version yields 409 with the
// current server state instead of silently overwriting it.
router.put('/:id', authenticateToken, withIdempotency((req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, body, summary, tags, version } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    if (version !== undefined && version !== null && Number(version) !== existing.version) {
      return res.status(409).json({
        error: 'Article has been updated by someone else since you loaded it',
        code: 'VERSION_CONFLICT',
        current: formatArticle(existing),
        meta: writeMeta({
          action: 'conflict',
          article: existing,
          previous: null,
          changed: []
        })
      });
    }

    const tagsStr = parseTags(tags);
    const now = new Date().toISOString();

    const updateResult = db.prepare(`
      UPDATE articles
      SET title = ?, body = ?, summary = ?, tags = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(title, body, summary || '', tagsStr, now, id);

    if (updateResult.changes === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    const changed = diffArticles(existing, { title, body, summary: summary || '', tagsStr });

    return res.respond(200, {
      ...formatArticle(article),
      meta: writeMeta({
        action: 'updated',
        article,
        previous: existing,
        changed
      })
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update article' });
  }
}));

// DELETE /api/articles/:id - Delete article (requires auth)
// The deleted snapshot is returned in meta.previous so the UI can show what
// was removed (and recover it if an undo flow is added later).
router.delete('/:id', authenticateToken, withIdempotency((req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    db.prepare('DELETE FROM articles WHERE id = ?').run(id);

    return res.respond(200, {
      message: 'Article deleted successfully',
      id: Number(id),
      meta: writeMeta({
        action: 'deleted',
        article: null,
        previous: existing,
        changed: WRITABLE_FIELDS
      })
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete article' });
  }
}));

// GET /api/articles/idempotency/:key is registered on the parent app
// (see server.js) because "/:id" would otherwise capture "idempotency".

// GET /api/tags - Get all unique tags (exported for use in server.js)
function getTags(req, res) {
  const db = getDb();

  try {
    const articles = db.prepare('SELECT tags FROM articles WHERE tags IS NOT NULL AND tags != ""').all();
    const tagSet = new Set();

    articles.forEach(article => {
      if (article.tags) {
        article.tags.split(',').forEach(tag => {
          const trimmed = tag.trim();
          if (trimmed) tagSet.add(trimmed);
        });
      }
    });

    const tags = Array.from(tagSet).sort();
    res.json({ tags });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
}

module.exports = router;
module.exports.getTags = getTags;
module.exports.getIdempotencyStatus = getIdempotencyStatus;

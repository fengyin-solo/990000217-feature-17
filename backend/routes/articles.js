const express = require('express');
const { getDb } = require('../db/init');
const { authenticateToken } = require('../middleware/auth');
const { idempotent, IDEMPOTENCY_TTL_MS } = require('../middleware/idempotency');

const router = express.Router();

const FIELD_LABELS = {
  title: '标题',
  body: '正文',
  summary: '摘要',
  tags: '标签'
};

function tagsToArray(tags) {
  return tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
}

function serializeArticle(article) {
  return {
    ...article,
    tags: tagsToArray(article.tags)
  };
}

// Record the inverse of a write so it can be restored within the TTL.
// `snapshot` is the article row before the write (null when it did not exist).
function saveRevision(db, articleId, action, version, snapshot, changedFields) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO article_revisions
      (article_id, action, version, snapshot, changed_fields, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    articleId,
    action,
    version,
    snapshot ? JSON.stringify(snapshot) : null,
    changedFields ? JSON.stringify(changedFields) : null,
    new Date(now).toISOString(),
    new Date(now + IDEMPOTENCY_TTL_MS).toISOString()
  );
}

function pruneExpiredRevisions(db) {
  db.prepare('DELETE FROM article_revisions WHERE expires_at <= ?')
    .run(new Date().toISOString());
}

// Diff the write payload against the previous row.
function computeChanges(before, fields, tagsBefore, tagsAfter) {
  const changedFields = [];
  if (!before) {
    for (const field of Object.keys(FIELD_LABELS)) {
      changedFields.push({
        field,
        label: FIELD_LABELS[field],
        before: null,
        after: field === 'tags' ? tagsAfter : fields[field]
      });
    }
    return changedFields;
  }

  const previous = {
    title: before.title,
    body: before.body,
    summary: before.summary || '',
    tags: tagsToArray(before.tags)
  };
  const current = {
    title: fields.title,
    body: fields.body,
    summary: fields.summary,
    tags: tagsAfter
  };

  for (const field of Object.keys(FIELD_LABELS)) {
    const oldValue = previous[field];
    const newValue = current[field];
    const isDifferent = Array.isArray(oldValue)
      ? oldValue.join(',') !== newValue.join(',')
      : oldValue !== newValue;
    if (isDifferent) {
      changedFields.push({
        field,
        label: FIELD_LABELS[field],
        before: oldValue,
        after: newValue
      });
    }
  }
  return changedFields;
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

    const parsedArticles = articles.map(serializeArticle);

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

// GET /api/tags - Get all unique tags (mounted in server.js, kept here as
// the original getTags export; also exposed at /api/articles/tags below)
function getTags(req, res) {
  const db = getDb();

  try {
    const articles = db.prepare("SELECT tags FROM articles WHERE tags IS NOT NULL AND tags != ''").all();
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

router.get('/tags', getTags);

// GET /api/articles/:id - Get single article
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json(serializeArticle(article));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// POST /api/articles - Create article (requires auth)
router.post('/', authenticateToken, idempotent, (req, res) => {
  const db = getDb();
  const { title, body, summary, tags } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    pruneExpiredRevisions(db);

    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const now = new Date().toISOString();
    const tagsList = tagsToArray(tagsStr);
    const fields = { title, body, summary: summary || '', tags: tagsList };

    const changedFields = computeChanges(null, fields, [], tagsList);

    const txResult = db.transaction(() => {
      const insertResult = db.prepare(`
        INSERT INTO articles (title, body, summary, tags, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(title, body, summary || '', tagsStr, now, now);

      const articleId = Number(insertResult.lastInsertRowid);
      const created = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      saveRevision(db, articleId, 'create', 1, null, changedFields);
      const revision = db.prepare(`
        SELECT expires_at FROM article_revisions
        WHERE article_id = ? AND action = 'create'
        ORDER BY id DESC LIMIT 1
      `).get(articleId);
      return { created, expiresAt: revision.expires_at };
    })();

    res.status(201).json({
      ...serializeArticle(txResult.created),
      meta: {
        action: 'created',
        changed: changedFields,
        current: {
          version: txResult.created.version,
          updated_at: txResult.created.updated_at
        },
        recoverable: {
          canUndo: true,
          action: 'create',
          revisionId: null,
          method: 'DELETE',
          path: `/api/articles/${txResult.created.id}`,
          expiresAt: txResult.expiresAt,
          message: '可删除该文章以撤销创建'
        },
        serverTime: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create article' });
  }
});

// PUT /api/articles/:id - Update article (requires auth)
//
// Body may include `version` (the version the editor loaded). When it is
// present and differs from the stored version, another writer committed a
// concurrent change and the request is rejected with 409 VERSION_CONFLICT
// instead of silently overwriting. Omit `version` to force the update
// (kept compatible with old clients).
router.put('/:id', authenticateToken, idempotent, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, body, summary, tags, version } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  try {
    pruneExpiredRevisions(db);

    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    if (version !== undefined && version !== null && Number(version) !== Number(existing.version)) {
      const current = serializeArticle(existing);
      res.set('X-Current-Version', String(existing.version));
      return res.status(409).json({
        error: '内容已被其他操作更新，请刷新后再编辑',
        code: 'VERSION_CONFLICT',
        current,
        meta: {
          action: 'conflict',
          current: {
            version: existing.version,
            updated_at: existing.updated_at
          },
          serverTime: new Date().toISOString()
        }
      });
    }

    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const tagsList = tagsToArray(tagsStr);
    const fields = { title, body, summary: summary || '', tags: tagsList };
    const changedFields = computeChanges(existing, fields, existing.tags, tagsList);

    if (changedFields.length === 0) {
      return res.json({
        ...serializeArticle(existing),
        meta: {
          action: 'unchanged',
          changed: [],
          current: {
            version: existing.version,
            updated_at: existing.updated_at
          },
          recoverable: { canUndo: false },
          serverTime: new Date().toISOString()
        }
      });
    }

    const now = new Date().toISOString();
    const nextVersion = Number(existing.version) + 1;

    const revisionRow = db.transaction(() => {
      saveRevision(db, Number(id), 'update', nextVersion, existing, changedFields);
      db.prepare(`
        UPDATE articles SET title = ?, body = ?, summary = ?, tags = ?,
          version = ?, updated_at = ?
        WHERE id = ?
      `).run(title, body, summary || '', tagsStr, nextVersion, now, id);
      return db.prepare(`
        SELECT id, expires_at FROM article_revisions
        WHERE article_id = ? AND action = 'update'
        ORDER BY id DESC LIMIT 1
      `).get(id);
    })();

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    res.json({
      ...serializeArticle(article),
      meta: {
        action: 'updated',
        changed: changedFields,
        current: {
          version: article.version,
          updated_at: article.updated_at
        },
        recoverable: {
          canUndo: true,
          action: 'update',
          revisionId: revisionRow.id,
          method: 'POST',
          path: `/api/articles/${id}/restore`,
          expiresAt: revisionRow.expires_at,
          message: '可恢复为更新前的内容'
        },
        serverTime: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update article' });
  }
});

// DELETE /api/articles/:id - Delete article (requires auth)
router.delete('/:id', authenticateToken, idempotent, (req, res) => {
  const db = getDb();
  const { id } = req.params;

  try {
    pruneExpiredRevisions(db);

    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const revision = db.transaction(() => {
      saveRevision(db, Number(id), 'delete', Number(existing.version) + 1, existing, null);
      db.prepare('DELETE FROM articles WHERE id = ?').run(id);
      return db.prepare(`
        SELECT id, expires_at FROM article_revisions
        WHERE article_id = ? AND action = 'delete'
        ORDER BY id DESC LIMIT 1
      `).get(id);
    })();

    res.json({
      message: 'Article deleted successfully',
      meta: {
        action: 'deleted',
        changed: [{
          field: null,
          label: '整篇文章',
          before: {
            id: existing.id,
            title: existing.title,
            version: existing.version
          },
          after: null
        }],
        current: null,
        recoverable: {
          canUndo: true,
          action: 'delete',
          revisionId: revision.id,
          method: 'POST',
          path: `/api/articles/${id}/restore`,
          expiresAt: revision.expires_at,
          message: '可在恢复期限内撤销删除'
        },
        serverTime: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});

// POST /api/articles/:id/restore - Undo the latest write (requires auth)
router.post('/:id/restore', authenticateToken, idempotent, (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const revisionId = req.body && req.body.revisionId;

  try {
    pruneExpiredRevisions(db);

    const revision = revisionId
      ? db.prepare('SELECT * FROM article_revisions WHERE id = ? AND article_id = ?').get(revisionId, id)
      : db.prepare('SELECT * FROM article_revisions WHERE article_id = ? ORDER BY id DESC LIMIT 1').get(id);

    if (!revision) {
      return res.status(404).json({ error: 'No recoverable version found' });
    }
    if (revision.expires_at <= new Date().toISOString()) {
      return res.status(410).json({
        error: '可恢复的版本已过期',
        code: 'RECOVERY_EXPIRED',
        meta: { action: 'restore-expired' }
      });
    }

    const snapshot = revision.snapshot ? JSON.parse(revision.snapshot) : null;
    const now = new Date().toISOString();
    const currentRow = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    const result = db.transaction(() => {
      if (!snapshot) {
        // Inverse of a create: article goes back to "did not exist".
        // Record the live row as the next snapshot so redoing this restore
        // brings the created article back.
        const rowToRevisit = currentRow;
        db.prepare('DELETE FROM articles WHERE id = ?').run(id);
        saveRevision(db, Number(id), 'restore', Number(rowToRevisit.version), rowToRevisit, null);
        return null;
      }

      const nextVersion = currentRow ? Number(currentRow.version) + 1 : Number(snapshot.version || 1);
      if (currentRow) {
        db.prepare(`
          UPDATE articles SET title = ?, body = ?, summary = ?, tags = ?,
            version = ?, created_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          snapshot.title, snapshot.body, snapshot.summary || '', snapshot.tags || '',
          nextVersion, snapshot.created_at, now, id
        );
      } else {
        db.prepare(`
          INSERT INTO articles (id, title, body, summary, tags, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, snapshot.title, snapshot.body, snapshot.summary || '', snapshot.tags || '',
          nextVersion, snapshot.created_at, now
        );
      }
      // Snapshot the pre-restore row so the next restore can redo the
      // write that this one undid.
      saveRevision(db, Number(id), 'restore', nextVersion, currentRow, null);
      return db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    })();

    res.status(200).json({
      message: 'Article restored successfully',
      ...(result ? serializeArticle(result) : {}),
      meta: {
        action: 'restored',
        restoredRevisionId: revision.id,
        undoneAction: revision.action,
        current: result
          ? { version: result.version, updated_at: result.updated_at }
          : null,
        serverTime: now
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restore article' });
  }
});

module.exports = router;
module.exports.getTags = getTags;

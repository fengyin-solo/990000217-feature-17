const express = require('express');
const cors = require('cors');
const path = require('path');
const initDb = require('./db/init');
const articlesRouter = require('./routes/articles');
const authRouter = require('./routes/auth');
const { authenticateToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
initDb();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/articles', articlesRouter);

// Tags route
const { getTags, getIdempotencyStatus } = require('./routes/articles');
app.get('/api/tags', getTags);

// Check the outcome of a previously submitted write after an ambiguous
// failure (expired token, timeout, duplicate submission). Requires auth so
// only an authenticated admin can probe request status.
app.get('/api/idempotency/:key', authenticateToken, getIdempotencyStatus);

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

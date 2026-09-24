# Blog Platform

A lightweight personal blog platform built with Vue 3 + Vite (frontend) and Node.js + Express (backend).

## Tech Stack

### Frontend
- **Vue 3** - Progressive JavaScript framework
- **Vite** - Next generation frontend tooling
- **Vue Router** - Official router for Vue.js
- **Pinia** - State management library
- **Element Plus** - Vue 3 UI component library
- **Axios** - HTTP client
- **Marked** - Markdown parser

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web application framework
- **better-sqlite3** - Fast SQLite3 library
- **jsonwebtoken** - JWT implementation
- **cors** - Cross-Origin Resource Sharing

## Project Structure

```
blog-platform/
├── frontend/          # Vue 3 + Vite frontend
│   ├── src/
│   │   ├── api/       # API client
│   │   ├── components/# Reusable components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores
│   │   └── views/     # Page components
│   └── ...
├── backend/           # Node.js + Express backend
│   ├── db/            # Database initialization and seeds
│   ├── routes/        # API routes
│   ├── middleware/    # Express middleware
│   └── data/          # SQLite database file
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone or navigate to the project directory**

```bash
cd blog-platform
```

2. **Install backend dependencies**

```bash
cd backend
npm install
```

3. **Install frontend dependencies**

```bash
cd ../frontend
npm install
```

4. **Initialize the database with seed data**

```bash
cd ../backend
npm run seed
```

### Running the Application

1. **Start the backend server (port 3001)**

```bash
cd backend
npm run dev
```

The API server will start at `http://localhost:3001`

2. **Start the frontend development server (port 5173)**

Open a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`

## Features

- **Article Management**: Create, read, update, and delete blog articles
- **Markdown Support**: Write articles in Markdown with live preview
- **Tag System**: Organize articles with tags and filter by tags
- **Pagination**: Navigate through articles with pagination (10 per page)
- **Admin Panel**: Protected admin area for managing articles
- **JWT Authentication**: Secure admin login with JSON Web Tokens

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article | No |
| POST | `/api/articles` | Create new article | Yes |
| PUT | `/api/articles/:id` | Update article | Yes |
| DELETE | `/api/articles/:id` | Delete article | Yes |
| POST | `/api/articles/:id/restore` | Undo latest write / restore article | Yes |
| GET | `/api/tags` | Get all unique tags | No |

### Save feedback, concurrency and duplicate-submit safety

Write responses (create/update/delete) keep their original payload fields and
additionally return a `meta` object:

- `meta.action` — `created` / `updated` / `unchanged` / `deleted` / `restored` / `conflict`
- `meta.changed` — the fields changed by this write (`title` / `body` / `summary` / `tags`), each with the `before` and `after` value
- `meta.current` — the resulting `version` and `updated_at` (null after delete)
- `meta.recoverable` — how to undo the write: `method`, `path`, `revisionId` and `expiresAt` (24h TTL)

**Concurrent editing (optimistic locking):** articles carry an integer
`version`. Sending the loaded `version` with a PUT makes the server reject the
write with `409 VERSION_CONFLICT` (plus the current article in `current`) when
someone else committed a change first. Omitting `version` forces the update
(old clients remain compatible).

**Idempotent writes:** send an `Idempotency-Key` header on POST/PUT/DELETE.
The first response is stored for 24h and any retry after a timeout, expired
token or double submit is replayed verbatim (`Idempotent-Replay: true`
header), so the write happens at most once. Reusing a key with a different
request body returns `409 IDEMPOTENCY_KEY_MISMATCH`.

**Recoverable state:** every write stores a pre-write snapshot in
`article_revisions`. `POST /api/articles/:id/restore` (optionally with
`{ "revisionId": <id> }`) applies the inverse — restoring a deleted article,
rolling an update back, or removing a created article. Expired revisions
return `410 RECOVERY_EXPIRED`.

The admin UI persists pending writes and local drafts in localStorage:
re-entering the editor replays an unconfirmed write with the same
idempotency key to restore the correct state, a conflict offers
"load latest" / "force overwrite", and a deleted article shows an undo
notification.


## Admin Credentials

- **Username**: admin
- **Password**: admin123

## Configuration

### Backend

- Server port: `3001` (configurable via `PORT` environment variable)
- JWT secret: `blog-platform-secret-key` (hardcoded in middleware/auth.js)
- Database file: `backend/data/blog.db`

### Frontend

- Dev server port: `5173`
- API proxy: `/api` requests are proxied to `http://localhost:3001`

## Build for Production

### Backend

The backend runs directly with Node.js:

```bash
cd backend
npm start
```

### Frontend

Build the frontend for production:

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`

## License

MIT

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
- **Safe concurrent editing**: Optimistic locking via article `version`; a
  stale update returns `409 VERSION_CONFLICT` with the current server state
- **Idempotent writes**: Send an `Idempotency-Key` header on create /
  update / delete to make retries and duplicate submissions replay the first
  result instead of writing twice; every write response includes a `meta`
  envelope (changed fields, recoverable previous snapshot, new version)

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article (includes `version`) | No |
| POST | `/api/articles` | Create new article (`Idempotency-Key` optional) | Yes |
| PUT | `/api/articles/:id` | Update article (optional `version` for optimistic locking; `Idempotency-Key` optional) | Yes |
| DELETE | `/api/articles/:id` | Delete article (`Idempotency-Key` optional; deleted snapshot in `meta.previous`) | Yes |
| GET | `/api/idempotency/:key` | Look up the outcome of a previously submitted write | Yes |
| GET | `/api/tags` | Get all unique tags | No |

### Write feedback envelope

Successful write responses keep the article fields at the top level and add:

```json
{
  "id": 1,
  "title": "...",
  "version": 2,
  "meta": {
    "action": "created | updated | deleted",
    "changed": ["title", "tags"],
    "previous": { "id": 1, "title": "old", "version": 1, "...": "..." },
    "version": 2,
    "updatedAt": "2026-09-24T00:00:00.000Z",
    "replayed": false
  }
}
```

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

# Collaborative Realtime Workspace — Backend

The backend for the real-time collaborative workspace: a Node.js/Express service that hosts a **custom Yjs CRDT WebSocket server**, a REST API, and background workers — designed to run across multiple instances behind a load balancer.

---

## ✨ What it does

- **CRDT synchronization** — a custom Yjs WebSocket server (`crdt/WSServer.js`) implements the full `y-protocols` binary sync handshake. Incoming document deltas are merged into the shared `Y.Doc` and rebroadcast to all peers; conflicting edits resolve automatically without central locking.
- **Live presence** — the Yjs Awareness protocol broadcasts cursor positions, user metadata, and laser-pointer state to all peers on a board. Awareness states are cleaned up precisely per-connection on disconnect.
- **Horizontal scaling** — Yjs document deltas fan out across server instances via **Redis pub/sub** (`yjs:<boardId>` channel), so users connected to different Node processes stay in sync. Awareness frames relay over a parallel `awareness:<boardId>` channel (instance-id-prefixed to drop self-echoes), so cursors and presence work cross-instance too — including ghost-cursor cleanup when a peer on another instance disconnects.
- **Hardened write path** — client updates are validated before `Y.applyUpdate`: a 512 KB size cap and try/catch isolation so a malformed frame is logged and dropped instead of crashing the server. Pure-replay updates are handled natively by Yjs (idempotent via state vectors).
- **Write-behind persistence** — a **BullMQ** scheduler marks dirty docs every 30 seconds and enqueues persist jobs; a dedicated worker (concurrency 5) encodes and writes `Y.Doc` state to MongoDB. The dirty flag clears only after the job is durably enqueued, preventing silent data loss on crash.
- **History compaction** — Yjs docs grow monotonically (every erased shape leaves a tombstone; throttled drag writes leave per-key history chains), so `yjsState` bloats even at constant shape count. `DocumentManager` compacts on **room teardown** — when the last peer leaves — by replaying the doc's current logical values into a throwaway fresh doc and persisting *that* slim snapshot. Doing it at teardown means the rebuild never blocks a client's sync handshake (the room is empty) and the next cold load reads small, cheap-to-replay bytes. The savings on history-heavy docs are large — a synthetic board with a long per-key write chain compacted **68 KB → 5 KB (~93%)** in testing. Only persists the compacted form when it's ≤ 80% of the original; nested Y.Maps (votes, comments) are reconstructed rather than flattened so CRDT merge semantics survive a reload.
- **Authorization at the trust boundary** — `viewer`/`commenter`/`editor` roles are enforced **per Yjs sync message**, so a viewer cannot mutate a board even over a raw WebSocket.
- **Distributed rate limiting** — `express-rate-limit` + `rate-limit-redis` with shared Redis counters across instances, split into auth (50/15 min) and general API (300/15 min) tiers.
- **Board-metadata cache** — access metadata (`owner`, `collaborators`, `isPublic`, `publicRole`, workspace members) is Redis-cached (`board:meta:<id>`, 60 s TTL) with explicit invalidation on share / unshare / publish / delete / leave, removing a cold MongoDB read from every WebSocket connection.
- **Self-service membership** — non-owner collaborators can leave a board (`DELETE /boards/leave/:id`) or a workspace (`DELETE /workspaces/:id/leave`, which also removes them from that workspace's boards); owners are rejected and must delete instead. Both paths invalidate the affected boards' metadata cache.
- **External API resilience** — Gemini calls wrapped with a 10 s timeout, exponential-backoff retries (transient errors only), and a shared circuit breaker (5 failure threshold, 30 s cooldown) (AI feature removed; patterns documented in `concepts.md`).
- **Health & readiness probes** — `GET /health` (MongoDB + Redis) and `GET /ready` (+ BullMQ workers running, persist-queue backpressure via `getWaitingCount`, and active-board count). `/ready` reports `not-ready` when the flush backlog exceeds the threshold so an orchestrator stops adding load until it drains.
- **Board publishing (synchronous)** — `POST /publish/:id` flips `isPublic`/`publicRole` with a single indexed MongoDB write and a cache invalidation, served inline in the request (a few ms). A previous BullMQ queue + worker for this was removed: a single fast write doesn't justify a queue, and queueing it returned `200` before the board was actually public. The queue is reserved for the persistence path, which is heavy and batched.
- **Graceful shutdown** — `SIGTERM`/`SIGINT`/`SIGUSR2` drain workers, close queues, and quit Redis clients before process exit.
- **Auth** — email/password and Google OAuth 2.0. **15-min JWT access tokens** (sent as `Authorization: Bearer`) are paired with **7-day refresh tokens** delivered in an `httpOnly`, `SameSite=Lax` cookie scoped to `/users`. Refresh tokens are persisted only as **SHA-256 hashes** in `user.refreshTokens[]` (one entry per device) and signed with a **separate secret** (`JWT_REFRESH_SECRET`) from access tokens; `POST /users/refresh` verifies the cookie cryptographically *and* against the DB before minting a new access token, and `POST /users/logout` pulls the stored hash atomically so the session is genuinely revoked. Each email is tied to exactly **one** method (password vs. Google); a custom-uploaded profile picture is never overwritten by a subsequent Google sign-in.
- **WebSocket ticket auth** — before opening a WebSocket, the frontend calls `POST /users/ws-ticket` (authenticated) to receive a 30-second single-use hex ticket stored in Redis (`ws:ticket:<hex>`). The ticket is passed as `?ticket=<hex>` on the WS upgrade URL; the upgrade gate reads and immediately DELetes it before handing the socket off, so a JWT never appears in any WS URL, server log, or proxy access log. Share-link visitors use `?st=<shareToken>` instead and are granted anonymous-viewer access.
- **Password reset** — `POST /users/forgot-password` emails a single-use link (SHA-256-hashed token, 15-min expiry, enumeration-safe generic response); `POST /users/reset-password/:token` verifies and sets the new password. Google-only accounts have no password, so they're excluded. Requires `EMAIL_USER`/`EMAIL_PASS` (Nodemailer/Gmail) and `FRONTEND_URL`.

---

## 🛠️ Tech Stack

- **Server:** Node.js, Express.js
- **Realtime:** Yjs (`y-protocols`, `y-websocket`, `lib0`), `ws` (native WebSocket), Redis pub/sub
- **Database:** MongoDB + Mongoose
- **Queues:** BullMQ + ioredis (Yjs write-behind persistence only)
- **AI:** ~~Google Gemini API~~ (removed)
- **Auth:** bcryptjs, jsonwebtoken, google-auth-library, cookie-parser
- **Media:** Cloudinary, multer
- **Email:** nodemailer

---

## 📂 Layout

```
backend/
├── crdt/
│   ├── WSServer.js              # Custom Yjs WebSocket server (sync protocol + RBAC + awareness)
│   ├── DocumentManager.js       # In-memory Y.Doc lifecycle: load, compaction, dirty tracking, GC
│   ├── persistenceScheduler.js  # 30-second heartbeat that enqueues BullMQ persist jobs
│   └── persistenceWorker.js     # BullMQ consumer: encodes Y.Doc → writes to MongoDB
├── cache/
│   └── project.cache.js         # Redis board:meta:* cache + resolveRole helper
├── middleware/
│   ├── auth.middleware.js        # Access-token (JWT) verification → req.email
│   ├── multer.middleware.js      # Multipart parsing: disk storage, 10 MB cap, MIME filter
│   ├── validate.middleware.js    # Request body/param validation (fields helpers)
│   ├── error.middleware.js       # Centralized Express error handler (APIError → HTTP response)
│   └── rate-limiters.middleware.js  # Redis-backed rate limiters
├── utils/
│   ├── jwt.js                   # signToken, verifyToken, signRefreshToken, verifyRefreshToken, getTokenExpiry
│   ├── APIError.js              # Structured error class (statusCode + message)
│   ├── APIResponse.js           # Structured success response helper
│   ├── sendResponse.js          # res.json wrapper for consistent response shape
│   ├── cloudinary.js            # Cloudinary SDK config + uploadToCloudinary() (temp-file cleanup)
│   ├── role.js                  # resolveRole helper
│   └── mailer.js                # Nodemailer: board invites & password-reset links
├── routes/
│   ├── health.routes.js         # GET /health and GET /ready probe endpoints
│   ├── project.routes.js
│   ├── user.routes.js           # auth, refresh/logout, profile, uploads, ws-ticket
│   ├── publish.routes.js        # synchronous publish/unpublish
│   └── workspace.routes.js
├── controllers/                 # Express route handlers (incl. upload.controller.js)
├── models/                      # Mongoose schemas (user.model.js has refreshTokens[], whiteboard.model.js, workspace.model.js)
└── index.js                     # Server bootstrap: HTTP + Yjs WS + workers + graceful shutdown
```

---

## 📦 Local Setup

### 1. Install

```bash
npm install
```

### 2. Environment

Copy `.env.example` to `.env` and fill in the values. Key variables:

```env
PORT=3030

# MongoDB — full URI in DB_CLUSTER_URL, or split DB_USERNAME/DB_PASSWORD/DB_CLUSTER_URL
DB_USERNAME=your-db-username
DB_PASSWORD=your-db-password
DB_CLUSTER_URL=cluster0.xxxxx.mongodb.net

# Redis — Yjs pub/sub, board-metadata cache, rate-limit store, BullMQ
REDIS_URL=redis://localhost:6379

# Auth — JWT_SECRET signs 15-min access tokens; JWT_REFRESH_SECRET signs 7-day
# refresh tokens (must be DIFFERENT values so the two types can't be swapped).
JWT_SECRET=your-jwt-secret
JWT_REFRESH_SECRET=your-separate-refresh-secret
JWT_EXPIRES_IN=15m            # optional; defaults to 15m
JWT_REFRESH_EXPIRES_IN=7d     # optional; defaults to 7d
GOOGLE_CLIENT_ID=your-google-oauth-client-id

# Gemini (AI brainstorming) — AI feature removed; key no longer used
# GOOGLE_API_KEY=your-gemini-api-key

# Email (Nodemailer/Gmail) — board invites & password-reset links.
# EMAIL_PASS must be a Gmail App Password (requires 2FA).
EMAIL_USER=your-gmail-address@gmail.com
EMAIL_PASS=your-gmail-app-password

# Allowed frontend origin(s) for CORS (comma-separated). Also used to build
# the password-reset link sent by email.
FRONTEND_URL=http://localhost:5173
```

> See [`.env.example`](.env.example) for the full list, including Cloudinary (media uploads) and SMTP (board-invite & password-reset email).

### 3. Run

```bash
npm run dev
```

The server starts on `PORT` (default `3030`). The Yjs WebSocket server is attached at the `/yjs` upgrade path on the same HTTP port.

---

## 🔭 Future Improvements

- **Incremental update log.** The persistence worker currently writes a full `Y.encodeStateAsUpdate` snapshot per flush, so a single element move can cause a large MongoDB write (write amplification). The planned replacement appends raw per-update chunks (20–200 bytes) to a `yjsUpdates` collection on each `ydoc.on('update')`, replays them in `seq` order on cold load, and compacts the log into a snapshot once it exceeds a threshold (~50 entries) — the same approach used by `y-leveldb` and Hocuspocus persistence adapters. Touches `DocumentManager.js` + `persistenceWorker.js` and adds a `YjsUpdate` Mongoose model.

---

## 📜 License

MIT

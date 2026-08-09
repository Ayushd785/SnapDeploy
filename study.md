# SnapDeploy — Complete Architecture Study

> A Vercel-like deployment platform that lets users deploy GitHub repositories to a live preview URL with a single click. Built as a microservice architecture with automated 5-minute teardown.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Microservice Breakdown](#3-microservice-breakdown)
4. [Data Flow — End to End](#4-data-flow--end-to-end)
5. [Inter-Service Communication](#5-inter-service-communication)
6. [Object Storage (S3 / DO Spaces)](#6-object-storage-s3--do-spaces)
7. [Redis — Message Queue & Status Store](#7-redis--message-queue--status-store)
8. [Frontend Deep Dive](#8-frontend-deep-dive)
9. [Deployment & Infrastructure](#9-deployment--infrastructure)
10. [Environment Variables](#10-environment-variables)
11. [Key Design Decisions](#11-key-design-decisions)
12. [Limitations & Areas for Improvement](#12-limitations--areas-for-improvement)

---

## 1. Project Overview

**SnapDeploy** is a simplified clone of Vercel that demonstrates the core concepts behind how modern deployment platforms work:

- **User provides** a GitHub repo URL via the frontend.
- **Backend clones** the repo, uploads raw source to object storage, queues a build job.
- **Worker service** picks up the job, downloads source, runs `npm install && npm run build`, uploads compiled output.
- **Request handler** serves the built site on a unique subdomain (e.g., `abc12.ayushd785.dev`).
- **Auto-teardown** deletes the deployment from S3 after 5 minutes.

### Tech Stack

| Layer             | Technology                                      |
|-------------------|------------------------------------------------|
| Frontend          | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend APIs      | Node.js, Express.js, TypeScript                |
| Message Queue     | Redis (Lists — `LPUSH` / `BRPOP`)              |
| Status Store      | Redis (Hash — `HSET` / `HGET`)                 |
| Object Storage    | DigitalOcean Spaces (S3-compatible API)         |
| Git Operations    | `simple-git` npm package                        |
| Process Manager   | PM2                                             |
| Hosting           | DigitalOcean Droplet + Nginx reverse proxy      |

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER BROWSER                              │
│   Frontend (React/Vite) — served on port 5173 via `serve -s dist`  │
└───────────────┬──────────────────────────┬──────────────────────────┘
                │ POST /deploy             │ GET /status?id=xxx
                │ (GitHub URL)             │ (polling every 3s)
                ▼                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              UPLOAD SERVICE (Express — port 3000)                   │
│                                                                     │
│  1. Generates unique 5-char ID (e.g., "a3f9k")                    │
│  2. Clones repo to local disk: ./output/{id}/                      │
│  3. Recursively reads all files (skipping .git, node_modules)      │
│  4. Uploads each file to S3: output/{id}/...                       │
│  5. Pushes ID to Redis list "build-queue" (LPUSH)                  │
│  6. Sets Redis hash status[id] = "uploaded"                        │
│  7. Returns { id } to frontend                                     │
│                                                                     │
│  GET /status → reads Redis hash status[id], returns { status }     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ Redis LPUSH "build-queue"
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│             DEPLOY SERVICE (Worker — no HTTP server)                │
│                                                                     │
│  Infinite loop: BRPOP "build-queue" (blocking pop)                 │
│                                                                     │
│  1. Downloads all files from S3 prefix output/{id}/ to local disk  │
│  2. Runs: cd output/{id} && npm install && npm run build           │
│  3. Detects build output folder (dist/ → build/ → out/ → root)    │
│  4. Uploads compiled files to S3: dist/{id}/...                    │
│  5. Sets Redis status[id] = "deployed"                             │
│  6. Stores deployment:${id}:created_at = Date.now() in Redis       │
│  7. Schedules setTimeout(300s) to purge S3 & set status "expired"  │
│                                                                     │
│  On build failure: Sets Redis status[id] = "failed"                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│           REQUEST HANDLER (Express — port 3001)                     │
│                                                                     │
│  Serves deployed sites via wildcard subdomain routing               │
│  e.g., http://a3f9k.ayushd785.dev → S3 key: dist/a3f9k/index.html │
│                                                                     │
│  1. Extracts deployment ID from hostname: host.split(".")[0]        │
│  2. Checks Redis for status & created_at timestamp                 │
│  3. If expired (>5 min or status="expired"):                       │
│     → Returns styled 410 HTML page ("Deployment Expired")          │
│     → Triggers S3 cleanup if not already done                      │
│  4. If active: Fetches S3 key dist/{id}/{filepath}                 │
│     → Sets correct MIME type via mime-types                         │
│     → Streams file content to browser                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Microservice Breakdown

### 3.1 Upload Service (`vercel-upload-service`)

**Port:** 3000  
**Role:** API gateway — receives deploy requests, clones repos, uploads source to S3, enqueues builds.

| File       | Purpose |
|------------|---------|
| `index.ts` | Express server with `POST /deploy` and `GET /status` endpoints. Creates Redis publisher/subscriber clients. |
| `aws.ts`   | S3 client config and `uploadFile()` function that reads a local file and uploads to DO Spaces. |
| `file.ts`  | `getAllFiles()` — recursive directory walker that returns all file paths, ignoring `.git` and `node_modules`. |
| `utils.ts` | `generate()` — creates a random 5-character alphanumeric ID for each deployment. |

**Key Dependencies:** `express`, `cors`, `simple-git`, `aws-sdk`, `redis`, `dotenv`

#### POST /deploy — Step by Step

```
1. Extract repoUrl from request body
2. Generate 5-char unique ID → e.g., "a3f9k"
3. Clone repo: simpleGit().clone(repoUrl, "./output/a3f9k/")
4. Walk directory tree → get array of all file paths
5. Upload every file to S3 bucket under key: output/a3f9k/...
6. LPUSH "build-queue" ← "a3f9k"  (enqueue for worker)
7. HSET "status" "a3f9k" "uploaded"
8. Return JSON: { id: "a3f9k" }
```

#### GET /status

```
1. Read query param: ?id=a3f9k
2. HGET "status" "a3f9k" → "uploaded" | "deployed" | "failed" | "expired"
3. Return JSON: { status: "deployed" }
```

---

### 3.2 Deploy Service (`vercel-deploy-service`)

**Port:** None (headless worker)  
**Role:** Background worker — consumes build queue, builds projects, uploads compiled output.

| File       | Purpose |
|------------|---------|
| `index.ts` | Main worker loop using `BRPOP` on Redis. Orchestrates download → build → upload → cleanup lifecycle. |
| `aws.ts`   | `downloadS3Folder()`, `copyFinalDist()`, `deleteS3Folder()`, `uploadFile()`, `getAllFiles()` |
| `utils.ts` | `buildProject(id)` — spawns `npm install --legacy-peer-deps && npm run build` via `child_process.exec()` |

**Key Dependencies:** `redis`, `aws-sdk`, `dotenv`, `child_process` (built-in)

#### Worker Loop — Step by Step

```
while (true) {
  1. BRPOP "build-queue" 0       → blocks until a job ID arrives
  2. downloadS3Folder("output/{id}")  → download all source files from S3 to local disk
  3. buildProject(id)            → cd output/{id} && npm install && npm run build
  4. If build succeeds:
     a. copyFinalDist(id)        → upload dist/build/out folder to S3 under dist/{id}/
     b. HSET "status" id "deployed"
     c. SET "deployment:{id}:created_at" Date.now()
     d. setTimeout(300s) → purge S3 folders + set status "expired"
  5. If build fails:
     a. HSET "status" id "failed"
}
```

#### Build Output Detection Logic

The `copyFinalDist()` function searches for the build output in this priority order:
1. `output/{id}/dist/` (Vite default)
2. `output/{id}/build/` (Create React App default)
3. `output/{id}/out/` (Next.js static export)
4. `output/{id}/` root if `index.html` exists (static sites)

#### Auto-Teardown Mechanism

After a successful deployment, a `setTimeout` of 300 seconds (5 minutes) fires:
- Sets Redis `status[id]` = `"expired"`
- Deletes `output/{id}/` from S3 (raw source)
- Deletes `dist/{id}/` from S3 (compiled output)

---

### 3.3 Request Handler (`vercel-request-handler`)

**Port:** 3001  
**Role:** Reverse proxy / static file server — resolves deployment IDs from subdomains and serves files from S3.

| File       | Purpose |
|------------|---------|
| `index.ts` | Express server with wildcard `GET /*` route. S3 client, Redis client, expiry checking, MIME resolution. |

**Key Dependencies:** `express`, `aws-sdk`, `redis`, `mime-types`, `dotenv`

#### Request Resolution — Step by Step

```
Incoming request: http://a3f9k.ayushd785.dev/styles/main.css

1. Extract host header → "a3f9k.ayushd785.dev"
2. Split by "." → take first part → id = "a3f9k"
3. filePath = req.path → "/styles/main.css" (default "/" → "/index.html")
4. Check Redis:
   a. HGET "status" "a3f9k" → check if "expired"
   b. GET "deployment:a3f9k:created_at" → check if >5 min elapsed
5. If expired → return 410 HTML with styled "Deployment Expired" page
   - Also trigger lazy S3 cleanup if status wasn't already "expired"
6. If active → fetch S3 key: dist/a3f9k/styles/main.css
7. Determine MIME type from file extension ("text/css")
8. Send file content with correct Content-Type header
```

#### Expired Deployment Page

When a deployment is expired, the handler returns a styled HTML page with:
- Dark glassmorphism card design
- ⌛ icon, red "Deployment Expired" heading
- Message about the 5-minute lifetime limit
- "SnapDeploy Teardown Engine" badge

---

## 4. Data Flow — End to End

```
USER                    FRONTEND              UPLOAD SVC            REDIS               DEPLOY SVC            S3/SPACES           REQ HANDLER
 │                        │                      │                    │                     │                    │                    │
 │──paste repo URL──────▶│                      │                    │                     │                    │                    │
 │                        │──POST /deploy───────▶│                    │                     │                    │                    │
 │                        │                      │──git clone────────│─────────────────────│────────────────────│                    │
 │                        │                      │──upload files─────│─────────────────────│──────────────────▶│ output/{id}/...    │
 │                        │                      │──LPUSH queue──────▶│                     │                    │                    │
 │                        │                      │──HSET "uploaded"──▶│                     │                    │                    │
 │                        │◀──{ id: "a3f9k" }───│                    │                     │                    │                    │
 │                        │                      │                    │                     │                    │                    │
 │                        │──GET /status (poll)─▶│                    │                     │                    │                    │
 │                        │                      │──HGET status──────▶│                     │                    │                    │
 │                        │◀──{ "uploaded" }────│                    │                     │                    │                    │
 │                        │                      │                    │                     │                    │                    │
 │                        │                      │                    │──BRPOP "a3f9k"─────▶│                    │                    │
 │                        │                      │                    │                     │──download files───▶│ output/{id}/...   │
 │                        │                      │                    │                     │◀─────────files─────│                    │
 │                        │                      │                    │                     │──npm install+build─│                    │
 │                        │                      │                    │                     │──upload dist──────▶│ dist/{id}/...      │
 │                        │                      │                    │◀──HSET "deployed"───│                    │                    │
 │                        │                      │                    │                     │                    │                    │
 │                        │──GET /status (poll)─▶│──HGET─────────────▶│                     │                    │                    │
 │                        │◀──{ "deployed" }────│                    │                     │                    │                    │
 │                        │──show deployed URL──▶│                    │                     │                    │                    │
 │                        │                      │                    │                     │                    │                    │
 │──visit a3f9k.domain───│──────────────────────│────────────────────│─────────────────────│────────────────────│───────────────────▶│
 │                        │                      │                    │                     │                    │◀──fetch dist/...───│
 │◀──────────────────────│──────────────────────│────────────────────│─────────────────────│────────────────────│──serve HTML/CSS/JS─│
 │                        │                      │                    │                     │                    │                    │
 │  ... 5 minutes pass ...│                      │                    │                     │                    │                    │
 │                        │                      │                    │◀──HSET "expired"────│                    │                    │
 │                        │                      │                    │                     │──deleteS3Folder───▶│ ❌ purged          │
```

---

## 5. Inter-Service Communication

### Communication Pattern: **Asynchronous Message Queue via Redis**

The services do **not** communicate via HTTP between each other. They use Redis as the message broker:

| Mechanism | Redis Command | Producer | Consumer | Purpose |
|-----------|--------------|----------|----------|---------|
| Build Queue | `LPUSH` / `BRPOP` on list `"build-queue"` | Upload Service | Deploy Service | Decouple API from build worker |
| Status Updates | `HSET` / `HGET` on hash `"status"` | Upload + Deploy Services | Upload Service (for `/status` endpoint) + Request Handler | Track deployment lifecycle |
| Timestamps | `SET` / `GET` on key `"deployment:{id}:created_at"` | Deploy Service | Request Handler | Enable time-based expiry checks |

### Why Redis Lists as a Queue?

- `BRPOP` is a **blocking pop** — the deploy worker blocks (zero CPU usage) until a new job arrives.
- `LPUSH` + `BRPOP` gives FIFO ordering (push left, pop right).
- `commandOptions({ isolated: true })` ensures the blocking call doesn't interfere with other Redis operations on the same connection.
- No need for a dedicated message broker like RabbitMQ for this scale.

---

## 6. Object Storage (S3 / DO Spaces)

### Bucket Structure

```
ayushcloud0704/                    ← DigitalOcean Spaces bucket
├── output/                        ← Raw cloned source code
│   ├── a3f9k/                     ← Deployment ID
│   │   ├── src/
│   │   │   ├── App.jsx
│   │   │   └── index.js
│   │   ├── package.json
│   │   └── index.html
│   └── b7x2m/
│       └── ...
└── dist/                          ← Compiled build output
    ├── a3f9k/
    │   ├── index.html
    │   ├── assets/
    │   │   ├── index-abc123.js
    │   │   └── index-abc123.css
    │   └── vite.svg
    └── b7x2m/
        └── ...
```

### S3 Client Configuration

All three services use the same S3 config pattern:
```typescript
const s3 = new S3({
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
    endpoint: process.env.DO_SPACES_ENDPOINT,  // "https://sfo3.digitaloceanspaces.com"
    s3ForcePathStyle: false,                    // Use virtual-hosted-style URLs
});
```

DigitalOcean Spaces is S3-compatible, so the `aws-sdk` works natively with it.

### Key S3 Operations

| Operation | Service | Function | S3 API |
|-----------|---------|----------|--------|
| Upload raw source | Upload Service | `uploadFile()` | `s3.upload()` |
| Download source for build | Deploy Service | `downloadS3Folder()` | `s3.listObjectsV2()` + `s3.getObject()` |
| Upload compiled output | Deploy Service | `copyFinalDist()` → `uploadFile()` | `s3.upload()` |
| Serve files to users | Request Handler | inline | `s3.getObject()` |
| Purge expired deployment | Deploy + Request Handler | `deleteS3Folder()` | `s3.listObjectsV2()` + `s3.deleteObjects()` |

---

## 7. Redis — Message Queue & Status Store

### Data Structures in Redis

```
KEY TYPE        KEY NAME                        VALUE                   PURPOSE
─────────────────────────────────────────────────────────────────────────────────
List            build-queue                     ["a3f9k", "b7x2m"]     Job queue (FIFO)
Hash            status                          { a3f9k: "deployed",   Deployment state machine
                                                  b7x2m: "uploaded" }
String          deployment:a3f9k:created_at     "1723190400000"        Timestamp for expiry check
```

### Deployment Status State Machine

```
  uploaded ──────▶ deployed ──────▶ expired
     │                                 ▲
     │                                 │
     └──────▶ failed                   │
                                 (5 min timeout)
```

### Redis Connection Pattern

All services use the same resilient connection setup:
- Support for `rediss://` (TLS) connections (DigitalOcean Managed Redis)
- `rejectUnauthorized: false` for self-signed DO certificates
- Exponential backoff reconnect strategy: `Math.min(retries * 100, 3000)`

---

## 8. Frontend Deep Dive

### Tech Stack
- **React 18** + **TypeScript** + **Vite** (build tool)
- **Tailwind CSS** with **shadcn/ui** component library (Radix UI primitives)
- **axios** for HTTP calls

### Component Architecture

```
main.tsx
  └── App.tsx
       └── Landing.tsx (the entire UI is a single page)
            ├── Card (shadcn/ui)
            ├── Input (shadcn/ui)
            ├── Button (shadcn/ui)
            └── Label (shadcn/ui)
```

### Frontend Flow

1. User pastes a GitHub URL into the input field.
2. Clicks "Upload" → `POST /deploy` with `{ repoUrl }`.
3. Button text changes to `"Deploying (a3f9k)"` and is disabled.
4. `setInterval(3000)` starts polling `GET /status?id=a3f9k`.
5. When status = `"deployed"` → shows success card with clickable URL.
6. When status = `"failed"` → shows red error card.

### URL Construction Logic

```typescript
// Deployed URL format:
const deployedUrl = `http://${uploadId}.${REQUEST_HANDLER_DOMAIN}/index.html`;
// Example: http://a3f9k.ayushd785.dev/index.html
```

The frontend dynamically resolves the backend URL and request handler domain:
- **Local dev**: `http://localhost:3000` for API, `localhost:3001` for previews
- **Production**: Uses relative URL `""` so Nginx handles routing, strips port from domain

---

## 9. Deployment & Infrastructure

### Server Architecture (DigitalOcean Droplet)

```
┌──────────────────── DigitalOcean Droplet ────────────────────┐
│                                                               │
│  ┌─────────────────── Nginx ───────────────────┐             │
│  │                                              │             │
│  │  app.ayushd785.dev:443 ──▶ localhost:5173    │  (Frontend) │
│  │  app.ayushd785.dev/deploy ──▶ localhost:3000 │  (Upload)   │
│  │  app.ayushd785.dev/status ──▶ localhost:3000 │  (Upload)   │
│  │  *.ayushd785.dev:80 ──▶ localhost:3001       │  (Handler)  │
│  │                                              │             │
│  └──────────────────────────────────────────────┘             │
│                                                               │
│  ┌─────────────────── PM2 ─────────────────────┐             │
│  │  upload-service   → node dist/index.js :3000 │             │
│  │  deploy-service   → node dist/index.js       │             │
│  │  request-handler  → node dist/index.js :3001 │             │
│  │  frontend         → serve -s dist -l 5173    │             │
│  └──────────────────────────────────────────────┘             │
│                                                               │
└───────────────────────────────────────────────────────────────┘

         ┌──────────────────────────┐
         │  DigitalOcean Spaces     │  (S3-compatible object storage)
         │  Bucket: ayushcloud0704  │
         │  Region: SFO3           │
         └──────────────────────────┘

         ┌──────────────────────────┐
         │  DigitalOcean Managed    │
         │  Redis (TLS)             │
         │  Region: BLR1           │
         └──────────────────────────┘
```

### PM2 Configuration (`ecosystem.config.js`)

Three services managed by PM2 with `--max-old-space-size=256` to limit memory on the droplet. The frontend is started separately via `pm2 start "serve -s dist -l 5173"`.

### Deploy Script (`deploy.sh`)

Automated deployment pipeline:
1. Stop all PM2 processes
2. `git reset --hard HEAD && git pull origin main`
3. Clean old `dist/` and `output/` folders
4. `npm install` in all 4 directories
5. `npx tsc` to compile TypeScript in 3 backend services
6. `npm run build` for frontend (Vite production build)
7. `pm2 start ecosystem.config.js` + start frontend
8. `pm2 save` for persistence across reboots

---

## 10. Environment Variables

### Upload Service (port 3000)
| Variable | Purpose |
|----------|---------|
| `PORT` | Express server port (3000) |
| `DO_SPACES_KEY` | DigitalOcean Spaces access key |
| `DO_SPACES_SECRET` | DigitalOcean Spaces secret key |
| `DO_SPACES_ENDPOINT` | Spaces endpoint URL |
| `DO_SPACES_BUCKET` | Bucket name |
| `REDIS_URL` | Redis connection string (supports `rediss://` for TLS) |

### Deploy Service (headless worker)
| Variable | Purpose |
|----------|---------|
| `DO_SPACES_KEY/SECRET/ENDPOINT/BUCKET` | Same S3 config |
| `REDIS_URL` | Same Redis connection |

### Request Handler (port 3001)
| Variable | Purpose |
|----------|---------|
| `PORT` | Express server port (3001) |
| `DO_SPACES_KEY/SECRET/ENDPOINT/BUCKET` | Same S3 config |
| `REDIS_URL` | Same Redis connection |

### Frontend
| Variable | Purpose |
|----------|---------|
| `VITE_BACKEND_UPLOAD_URL` | Upload service URL for API calls |
| `VITE_REQUEST_HANDLER_DOMAIN` | Domain for constructing preview URLs |

---

## 11. Key Design Decisions

### 1. Redis as Both Queue AND Status Store
Instead of using separate systems (e.g., RabbitMQ for queue + PostgreSQL for status), Redis handles both. This keeps the infrastructure minimal but trades off durability — if Redis crashes, all job state is lost.

### 2. Blocking Pop (`BRPOP`) for Worker
The deploy worker uses `BRPOP` with timeout `0` (infinite wait). This means the worker blocks with zero CPU until a job arrives — much more efficient than polling.

### 3. Subdomain-Based Routing
Each deployment gets a unique subdomain (`{id}.domain.com`). The request handler extracts the ID from the `Host` header. This mirrors how Vercel/Netlify handle preview deployments.

### 4. 5-Minute Auto-Teardown
Deployments auto-expire after 5 minutes via `setTimeout` in the deploy worker. This prevents unbounded S3 storage growth. The request handler also performs lazy cleanup on expired deployments via timestamp checks.

### 5. Dual Cleanup (Belt and Suspenders)
Both the deploy service AND request handler can trigger S3 cleanup. If the deploy service's `setTimeout` fires, it cleans up. If it crashes before that, the request handler detects expiry via timestamp and cleans up on the next request.

### 6. Build Output Detection Cascade
`copyFinalDist()` checks `dist/` → `build/` → `out/` → root `index.html`. This supports Vite, CRA, Next.js static, and plain HTML projects without configuration.

---

## 12. Limitations & Areas for Improvement

| Limitation | Impact | Possible Fix |
|-----------|--------|-------------|
| No database — all state in Redis | Volatile; restart loses history | Add PostgreSQL for deployment records |
| No authentication | Anyone can deploy any repo | Add GitHub OAuth + rate limiting |
| No build logs streaming | Users can't see build progress | WebSocket for real-time logs |
| Single worker | Builds are sequential | Scale workers horizontally (BRPOP is multi-consumer safe) |
| No monorepo support | Can't specify build directory | Add `buildDir` param to `/deploy` |
| `simple-git` clones full history | Slow for large repos | Use `--depth 1` for shallow clones |
| `exec()` for builds — no sandboxing | Arbitrary code execution risk | Use Docker containers for builds |
| No CDN | Every request hits S3 directly | Add CloudFront/Cloudflare CDN |
| S3 pagination not handled in upload | Repos with >1000 files may miss files | Handle `IsTruncated` + `ContinuationToken` |
| No framework detection | Only supports `npm run build` | Detect framework + use correct build command |
| Memory limited to 256MB per service | Large builds may OOM | Increase limits or use build containers |

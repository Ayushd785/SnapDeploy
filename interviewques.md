# SnapDeploy — Technical Interview Questions & Answers

---

## Section 1: Architecture & System Design

### Q1. Explain the high-level architecture of this project.

**A:** SnapDeploy is a Vercel-like deployment platform built with a **microservice architecture** consisting of 4 components:

1. **Frontend** (React/Vite) — Single-page app where users paste a GitHub URL.
2. **Upload Service** (Express, port 3000) — API gateway that clones the repo, uploads source to S3, and enqueues a build job in Redis.
3. **Deploy Service** (headless worker) — Consumes jobs from a Redis queue, downloads source from S3, runs `npm install && npm run build`, uploads compiled output back to S3.
4. **Request Handler** (Express, port 3001) — Serves deployed sites by resolving the deployment ID from the subdomain and fetching files from S3.

They communicate via **Redis** (as a message queue and status store) and share **DigitalOcean Spaces** (S3-compatible) as the object storage layer.

---

### Q2. Why did you choose a microservice architecture instead of a monolith?

**A:** Three key reasons:

1. **Separation of concerns** — The API layer (upload), build worker (deploy), and serving layer (request handler) have fundamentally different responsibilities and scaling characteristics.
2. **Independent scaling** — Build workers are CPU-intensive. I can scale them horizontally by running multiple instances — `BRPOP` on Redis is multi-consumer safe, so multiple workers can compete for jobs.
3. **Fault isolation** — If the build worker crashes during a build, the API and serving layer continue to work. The upload service doesn't block waiting for builds.

---

### Q3. Walk me through what happens when a user clicks "Deploy."

**A:**

1. Frontend sends `POST /deploy` with `{ repoUrl }` to the Upload Service.
2. Upload Service generates a unique 5-char ID (e.g., `a3f9k`).
3. It clones the repo to `./output/a3f9k/` using `simple-git`.
4. Recursively walks the directory (ignoring `.git`, `node_modules`) and uploads every file to S3 under the key prefix `output/a3f9k/`.
5. Pushes the ID `"a3f9k"` to the Redis list `build-queue` via `LPUSH`.
6. Sets `status["a3f9k"] = "uploaded"` in a Redis hash.
7. Returns `{ id: "a3f9k" }` to the frontend.
8. Frontend starts polling `GET /status?id=a3f9k` every 3 seconds.
9. Deploy Service (running an infinite loop with `BRPOP`) picks up `"a3f9k"` from the queue.
10. Downloads all files from S3 prefix `output/a3f9k/` to local disk.
11. Runs `npm install --legacy-peer-deps && npm run build` via `child_process.exec()`.
12. Detects the build output folder (`dist/` → `build/` → `out/` → root).
13. Uploads compiled files to S3 under `dist/a3f9k/`.
14. Sets `status["a3f9k"] = "deployed"` and stores a creation timestamp.
15. Frontend's next poll sees `"deployed"` → shows the preview URL: `http://a3f9k.ayushd785.dev`.
16. After 5 minutes, `setTimeout` fires → sets status to `"expired"`, deletes S3 objects.

---

### Q4. How do the microservices communicate with each other?

**A:** They use **asynchronous communication via Redis** — no direct HTTP calls between services.

- **Job Queue:** The Upload Service pushes job IDs to a Redis List (`LPUSH "build-queue"`). The Deploy Service consumes them with `BRPOP` (blocking pop).
- **Status Store:** Both Upload and Deploy Services write to a Redis Hash (`HSET "status" id value`). The Upload Service reads it for the `/status` endpoint, and the Request Handler reads it for expiry checks.
- **Timestamps:** The Deploy Service stores `deployment:{id}:created_at` as a Redis String. The Request Handler reads it for time-based expiry detection.

This is the **producer-consumer pattern** implemented with Redis Lists.

---

### Q5. Why Redis instead of RabbitMQ or Kafka for the message queue?

**A:**

- **Simplicity** — Redis Lists with `LPUSH`/`BRPOP` provide a lightweight FIFO queue without needing a dedicated message broker.
- **Dual purpose** — Redis also serves as the status store (Hash) and timestamp store (String), so one infrastructure component handles multiple needs.
- **Low overhead** — No need for complex ACKing, dead-letter queues, or consumer groups at this scale.
- **Trade-off:** Redis is not durable by default. If Redis crashes, queued jobs are lost. For production, I'd use Redis persistence (AOF) or switch to RabbitMQ for at-least-once delivery guarantees.

---

## Section 2: Backend Deep Dive

### Q6. Explain the `BRPOP` command and why you use it.

**A:** `BRPOP` is a **blocking right-pop** on a Redis List. It blocks the connection until an element is available or a timeout is reached.

```typescript
const res = await subscriber.brPop(
    commandOptions({ isolated: true }),
    'build-queue',
    0  // timeout: 0 = infinite wait
);
```

- **Why blocking?** Without it, the worker would need to poll Redis in a loop, wasting CPU. `BRPOP` makes the worker sleep with zero CPU usage until a job arrives.
- **Why `isolated: true`?** In `node-redis` v4, commands share a connection by default. `isolated: true` creates a dedicated connection for this blocking call so it doesn't block other Redis operations.
- **Why `BRPOP` (right pop)?** Combined with `LPUSH` (left push), it creates FIFO ordering — first job pushed is the first job processed.

---

### Q7. How does the build process work? What security concerns exist?

**A:** The `buildProject()` function uses `child_process.exec()`:

```typescript
exec(`cd ${projectDir} && NODE_ENV=development npm install --legacy-peer-deps && npm run build`)
```

**Security concerns:**
1. **Arbitrary code execution** — `npm install` runs lifecycle scripts (`preinstall`, `postinstall`) which can execute arbitrary code on the server. A malicious `package.json` could contain `"preinstall": "rm -rf /"`.
2. **No sandboxing** — The build runs directly on the host machine with the same user permissions as the service.
3. **Command injection** — If the deployment ID were user-controlled (it's not — it's randomly generated), it could be used for shell injection.

**Fixes for production:**
- Run builds inside **Docker containers** with restricted permissions.
- Use `--ignore-scripts` flag to skip lifecycle scripts.
- Set resource limits (CPU, memory, time) per build.
- Use a **chroot jail** or **gVisor** for sandboxing.

---

### Q8. How does the Request Handler serve files? Explain the subdomain routing.

**A:**

1. **Subdomain extraction:** When a request comes to `a3f9k.ayushd785.dev`, Nginx routes it to port 3001. The handler extracts the ID:
   ```typescript
   const host = req.headers.host.split(":")[0];  // "a3f9k.ayushd785.dev"
   const id = host.split(".")[0];                 // "a3f9k"
   ```

2. **Path mapping:** The request path maps directly to an S3 key:
   ```
   Request: /assets/style.css → S3 key: dist/a3f9k/assets/style.css
   Request: / → S3 key: dist/a3f9k/index.html (default)
   ```

3. **MIME type resolution:** Uses the `mime-types` package to set the correct `Content-Type` header based on file extension.

4. **Expiry checking:** Before serving, it checks Redis for `status === "expired"` OR if `Date.now() - created_at > 5 minutes`. If expired, returns a styled 410 HTML page.

---

### Q9. Explain the 5-minute auto-teardown mechanism. Why is there dual cleanup?

**A:** Two cleanup mechanisms exist (belt-and-suspenders approach):

**Primary (Deploy Service):** After successful deployment, a `setTimeout(300000)` schedules cleanup:
```typescript
setTimeout(async () => {
    await publisher.hSet("status", id, "expired");
    await deleteS3Folder(`output/${id}`);
    await deleteS3Folder(`dist/${id}`);
}, 300 * 1000);
```

**Secondary (Request Handler):** On every request, it checks the `deployment:{id}:created_at` timestamp:
```typescript
if (Date.now() - createdAt > 5 * 60 * 1000) {
    // Lazy cleanup — triggers S3 deletion if not already done
}
```

**Why dual cleanup?** If the Deploy Service crashes or restarts, the `setTimeout` is lost (it's in-memory). The Request Handler acts as a safety net — it detects stale deployments via timestamps and triggers cleanup on the next incoming request.

---

### Q10. How does `downloadS3Folder()` work?

**A:**
1. Calls `s3.listObjectsV2({ Prefix: "output/a3f9k" })` to list all objects under that prefix.
2. For each object key, creates the local directory structure using `fs.mkdirSync({ recursive: true })`.
3. Uses `s3.getObject().createReadStream()` to stream each file to disk via `pipe()`.
4. Wraps each download in a Promise and uses `Promise.all()` for parallel downloads.

**Limitation:** It doesn't handle S3 pagination (`IsTruncated` + `ContinuationToken`). If a repo has >1000 files, some would be missed. The `deleteS3Folder()` function *does* handle pagination correctly — this is an inconsistency.

---

### Q11. How does `copyFinalDist()` detect the correct build output folder?

**A:** It uses a cascading fallback strategy:
```
1. Check: output/{id}/dist/     → Vite, Rollup projects
2. Check: output/{id}/build/    → Create React App
3. Check: output/{id}/out/      → Next.js static export
4. Check: output/{id}/index.html exists? → Plain static site (use root)
5. None found → Log error, skip upload
```

This means it supports Vite, CRA, Next.js, and static HTML projects without any user configuration.

---

## Section 3: Frontend

### Q12. How does the frontend handle the deployment lifecycle?

**A:** Using React state and polling:

```typescript
const [uploading, setUploading] = useState(false);   // Upload in progress
const [deployed, setDeployed] = useState(false);      // Successfully deployed
const [failed, setFailed] = useState(false);           // Build or connection error
const [uploadId, setUploadId] = useState("");           // Deployment ID
```

**Flow:**
1. Click "Upload" → `setUploading(true)`, `POST /deploy`.
2. Response received → `setUploadId("a3f9k")`, `setUploading(false)`.
3. `setInterval(3000)` polls `/status?id=a3f9k`.
4. `"deployed"` → `clearInterval()`, `setDeployed(true)` → shows URL card.
5. `"failed"` → `clearInterval()`, `setFailed(true)` → shows error card.

**Why polling instead of WebSockets?** Simplicity. For a 30-60 second build, polling every 3 seconds is acceptable (10-20 requests). WebSockets would be better for streaming build logs in real-time.

---

### Q13. How does the frontend resolve backend URLs in development vs. production?

**A:** Two helper functions handle environment-aware URL resolution:

**`getBackendUploadUrl()`:**
- If `VITE_BACKEND_UPLOAD_URL` is set → use it.
- If running on a non-localhost domain → return `""` (empty string, so API calls go to the same origin and Nginx proxies them).
- Fallback → `"http://localhost:3000"`.

**`getRequestHandlerDomain()`:**
- If `VITE_REQUEST_HANDLER_DOMAIN` is set → use it.
- If on a non-localhost domain → extract the root domain from `window.location.hostname`.
- Fallback → `"localhost:3001"`.
- In production, strips the port number so wildcard Nginx routing works.

This means the frontend works both locally (direct port access) and in production (behind Nginx reverse proxy) without code changes.

---

## Section 4: Infrastructure & DevOps

### Q14. Explain the Nginx configuration for this project.

**A:** Nginx handles three routing rules:

1. **Frontend:** `app.ayushd785.dev` → proxy to `localhost:5173` (static file server).
2. **API routes:** `app.ayushd785.dev/deploy` and `/status` → proxy to `localhost:3000` (Upload Service).
3. **Wildcard subdomains:** `*.ayushd785.dev` on port 80 → proxy to `localhost:3001` (Request Handler).

The wildcard subdomain block is crucial — it's what makes `a3f9k.ayushd785.dev` route to the Request Handler, which then extracts `a3f9k` from the Host header.

---

### Q15. Why PM2? What does `ecosystem.config.js` do?

**A:** PM2 is a Node.js process manager that provides:
- **Auto-restart** on crash
- **Log management** 
- **Process monitoring** (`pm2 monit`)
- **Startup persistence** (`pm2 save` + `pm2 startup`)

The `ecosystem.config.js` defines three services:
```javascript
{
    name: "upload-service",
    cwd: "./vercel-upload-service",
    script: "node",
    args: "dist/index.js",
    node_args: "--max-old-space-size=256"  // Limit memory on small droplet
}
```

`--max-old-space-size=256` caps V8 heap at 256MB per service, important for a $6/month DigitalOcean droplet with limited RAM.

---

### Q16. Walk me through the deploy.sh script. What's the deployment strategy?

**A:** It's a **rolling in-place deployment**:

1. `pm2 delete all` — Stop all services (causes brief downtime).
2. `git reset --hard && git pull origin main` — Discard local changes, pull latest.
3. Clean old `dist/` and `output/` folders.
4. `npm install` in all 4 directories.
5. `npx tsc` to compile TypeScript for 3 backend services.
6. `npm run build` for Vite frontend production build.
7. `pm2 start ecosystem.config.js` — Start all services.
8. `pm2 save` — Persist process list for auto-restart on reboot.

**Downside:** There's downtime between step 1 and step 7. A zero-downtime deployment would require blue-green deployment or containers.

---

## Section 5: Cloud & Storage

### Q17. Why DigitalOcean Spaces instead of AWS S3?

**A:** 
- **Cost** — DO Spaces is $5/month for 250GB with free CDN. AWS S3 pricing is more complex.
- **Simplicity** — Single DigitalOcean account manages droplet, spaces, and managed Redis.
- **S3 compatibility** — The `aws-sdk` package works natively with DO Spaces, so no code changes needed if migrating to AWS later.

---

### Q18. Explain the S3 bucket key structure.

**A:** Two top-level prefixes:

- **`output/{id}/`** — Raw cloned source code (temporary, deleted after 5 min).
- **`dist/{id}/`** — Compiled build output served to users (deleted after 5 min).

Example for deployment `a3f9k`:
```
output/a3f9k/package.json
output/a3f9k/src/App.jsx
dist/a3f9k/index.html
dist/a3f9k/assets/index-abc123.js
```

The Request Handler maps `GET /assets/index-abc123.js` → S3 key `dist/a3f9k/assets/index-abc123.js`.

---

## Section 6: Tricky/Advanced Questions

### Q19. What happens if two users deploy at the same time?

**A:** It works correctly because:
1. Each deployment gets a **unique 5-char ID** (random generation has ~33^5 ≈ 40M combinations).
2. S3 uploads are under separate prefixes (`output/abc12/` vs `output/xyz89/`).
3. Redis `LPUSH` is atomic — both IDs get added to the queue.
4. The Deploy worker processes them **sequentially** (single worker). If we need parallelism, we can run multiple worker instances — `BRPOP` is multi-consumer safe (only one consumer gets each job).

---

### Q20. What are the race conditions in this system?

**A:**
1. **Status polling race:** The frontend might poll `/status` before the Deploy Service has started processing. This is fine — status returns `"uploaded"` and the frontend keeps polling.
2. **Expiry race in Request Handler:** Between checking status and fetching from S3, the deployment could expire and S3 objects could be deleted. This would cause a 404, which is handled gracefully.
3. **Dual cleanup race:** Both the Deploy Service's `setTimeout` and the Request Handler's lazy cleanup might try to delete S3 objects simultaneously. `deleteS3Folder()` handles this gracefully — deleting already-deleted objects is a no-op in S3.

---

### Q21. How would you scale this system for 1000 concurrent users?

**A:**
1. **Multiple deploy workers** — Run N instances of the deploy service. `BRPOP` distributes jobs automatically.
2. **Containerized builds** — Replace `exec()` with Docker containers for isolation and resource limits.
3. **CDN for serving** — Put CloudFront/Cloudflare in front of S3 to cache static assets.
4. **Horizontal scaling** — Put Upload Service and Request Handler behind a load balancer.
5. **Persistent queue** — Switch Redis to RabbitMQ or Amazon SQS for guaranteed delivery.
6. **Database** — Add PostgreSQL for deployment records, user accounts, build logs.
7. **Build caching** — Cache `node_modules` across builds for the same project.

---

### Q22. What would you add to make this production-ready?

**A:**
1. **Authentication** — GitHub OAuth to verify repo ownership.
2. **Build sandboxing** — Docker containers with resource limits.
3. **WebSocket build logs** — Stream `stdout`/`stderr` to the frontend.
4. **Custom domains** — Let users map their own domains.
5. **Persistent deployments** — Remove the 5-minute limit, add billing.
6. **CI/CD integration** — Auto-deploy on `git push` via webhooks.
7. **Rollback** — Keep previous deployment versions in S3.
8. **Health checks** — Liveness/readiness probes for each service.
9. **Rate limiting** — Prevent abuse of the deploy endpoint.
10. **SSL for preview sites** — Currently wildcard subdomains use HTTP.

---

### Q23. Why `--legacy-peer-deps` in the build command?

**A:** Many npm packages have conflicting peer dependency requirements (e.g., React 17 vs 18). `--legacy-peer-deps` tells npm to ignore peer dependency conflicts and install packages anyway. Without it, `npm install` would fail for many real-world repositories. This mirrors how Vercel's build system handles dependency conflicts.

---

### Q24. Explain the Redis connection configuration. Why `rejectUnauthorized: false`?

**A:**
```typescript
const redisOptions = {
    url: process.env.REDIS_URL,
    socket: {
        ...(url.startsWith("rediss://") ? { rejectUnauthorized: false } : {}),
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
    }
};
```

- **`rediss://`** — The double-s indicates TLS-encrypted Redis (DigitalOcean Managed Redis requires TLS).
- **`rejectUnauthorized: false`** — DigitalOcean's managed Redis uses self-signed certificates. Without this, Node.js would reject the TLS connection.
- **`reconnectStrategy`** — Exponential backoff with a 3-second cap. On disconnect, retries at 100ms, 200ms, 300ms... up to 3000ms.

---

### Q25. How does `deleteS3Folder()` handle large prefixes?

**A:**
```typescript
async function deleteS3Folder(prefix: string) {
    const listedObjects = await s3.listObjectsV2({ Bucket, Prefix: prefix }).promise();
    if (!listedObjects.Contents?.length) return;

    await s3.deleteObjects({
        Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key: Key! })) }
    }).promise();

    if (listedObjects.IsTruncated) {
        await deleteS3Folder(prefix);  // Recursive call for pagination
    }
}
```

S3 `listObjectsV2` returns max 1000 objects per call. If `IsTruncated` is true, there are more objects. The function recursively calls itself until all objects are deleted. `deleteObjects` can delete up to 1000 objects per call. This is a correct implementation of paginated S3 deletion.

---

### Q26. What is `commandOptions({ isolated: true })` in Redis?

**A:** In `node-redis` v4, a single Redis client shares one TCP connection for all commands. If you issue a `BRPOP` (blocking command) on this shared connection, it blocks ALL other commands on that client until the pop completes.

`isolated: true` tells the client to use a **separate, dedicated connection** for this specific command. This way, the blocking `BRPOP` doesn't prevent other Redis operations (like `HSET`, `HGET`) from executing.

---

### Q27. What is the `cn()` utility in the frontend?

**A:**
```typescript
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
```

It's a standard shadcn/ui utility that combines:
- **`clsx`** — Conditionally joins class names (handles booleans, arrays, objects).
- **`twMerge`** — Intelligently merges Tailwind CSS classes, resolving conflicts (e.g., `px-4 px-8` → `px-8`).

This lets components accept a `className` prop that cleanly overrides default styles without CSS specificity issues.

---

### Q28. Why does the frontend use `setInterval` for polling instead of WebSockets?

**A:** Trade-off analysis:

| Aspect | Polling (current) | WebSockets |
|--------|-------------------|------------|
| Implementation complexity | Low | Medium-high |
| Server resources | Slightly wasteful (10-20 extra HTTP requests) | Persistent connection per client |
| Real-time updates | 3-second delay | Instant |
| Build log streaming | Not possible | Possible |
| Scaling concerns | Stateless, easy to load-balance | Sticky sessions needed |

For a deployment that takes 30-60 seconds and only needs a status check, polling at 3-second intervals is perfectly acceptable. WebSockets would be warranted if streaming build logs.

---

### Q29. How does the frontend handle production vs development URLs without code changes?

**A:** The `getBackendUploadUrl()` function uses a cascading resolution:
1. If `VITE_BACKEND_UPLOAD_URL` env var is set → use it directly.
2. If running on a non-localhost domain (production) → return `""` (empty string).
   - This makes API calls like `POST /deploy` go to the same origin.
   - Nginx then reverse-proxies `/deploy` to port 3000.
3. Fallback (local dev) → `"http://localhost:3000"` (direct access).

This pattern means the same build works locally and in production. The empty string trick leverages relative URLs with Nginx proxying.

---

### Q30. If you were asked to add support for private GitHub repositories, how would you do it?

**A:**
1. **GitHub OAuth flow** — User authenticates via GitHub OAuth, we store their access token.
2. **Authenticated clone** — Modify the `simpleGit().clone()` call to use the token:
   ```typescript
   const authUrl = `https://oauth2:${token}@github.com/user/repo.git`;
   await simpleGit().clone(authUrl, outputPath);
   ```
3. **Token security** — Store tokens encrypted in a database (not Redis). Pass them to the deploy worker via the job payload (not just the ID).
4. **Token rotation** — Use GitHub Apps with installation tokens (short-lived) instead of personal access tokens.

---

### Q31. How would you implement zero-downtime deployments for SnapDeploy itself?

**A:** The current `deploy.sh` has downtime. Options:
1. **Docker + rolling updates** — Containerize each service. Use Docker Compose or Kubernetes to do rolling replacements (start new, health check, stop old).
2. **PM2 cluster mode** — Run each service in cluster mode (`instances: 2`). Use `pm2 reload` for zero-downtime restarts.
3. **Blue-green deployment** — Run two sets of services on different ports. Switch Nginx upstream after health checks pass.

---

### Q32. What's the difference between `output/` and `dist/` in the S3 bucket?

**A:**
- **`output/{id}/`** — Contains the raw cloned GitHub repository (source code, package.json, etc.). This is the *input* to the build process.
- **`dist/{id}/`** — Contains the compiled build artifacts (minified JS, CSS, HTML). This is what gets *served* to users.

Both are temporary and deleted after 5 minutes. The Request Handler only reads from `dist/` — it never touches `output/`.

---

### Q33. Explain the CORS setup. Why is it only on the Upload Service?

**A:** Only the Upload Service has `app.use(cors())` because it's the only service that receives cross-origin requests from the browser:
- Frontend on `app.ayushd785.dev` calls `POST /deploy` on the Upload Service.
- In development, the frontend runs on `localhost:5173` and the API on `localhost:3000` — different origins.

The Request Handler doesn't need CORS because users visit the deployed site directly (same origin — `a3f9k.ayushd785.dev`), and the Deploy Service has no HTTP server at all.

In production, Nginx reverse-proxying makes `/deploy` and `/status` same-origin, so CORS isn't technically needed. But it's kept for local development compatibility.

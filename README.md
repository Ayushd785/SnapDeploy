# SnapDeploy

A cloud-native deployment platform that builds and hosts React / static websites from a GitHub URL with a single click. Built with a microservice architecture — upload service, build worker, and request handler — communicating via Redis and serving compiled assets from S3-compatible object storage on unique wildcard subdomains.

---

## Architecture

```
┌────────────┐    POST /deploy     ┌──────────────────┐    Redis LPUSH    ┌──────────────────┐
│  Frontend  │ ──────────────────▶ │  Upload Service  │ ────────────────▶ │  Deploy Service  │
│  (React)   │ ◀── { id } ──────  │  (port 3000)     │                   │  (headless worker)│
│  port 5173 │    GET /status      │  Clone + S3 ↑    │                   │  Build + S3 ↑    │
└────────────┘ ──────────────────▶ └──────────────────┘                   └──────────────────┘
                                                                                   │
       ┌──────────────────┐                                                        │
       │  Request Handler │ ◀── serves dist/{id}/* from S3 ───────────────────────┘
       │  (port 3001)     │     via wildcard subdomain routing
       │  {id}.domain.com │
       └──────────────────┘
```

| Component | Role | Port |
|-----------|------|------|
| `frontend/` | React UI — paste GitHub URL, see deploy status | 5173 |
| `vercel-upload-service/` | REST API — clones repo, uploads to S3, enqueues build | 3000 |
| `vercel-deploy-service/` | Worker — consumes queue, runs `npm build`, uploads dist | — |
| `vercel-request-handler/` | Reverse proxy — serves deployed sites from S3 via subdomains | 3001 |

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Redis** (local or managed instance)
- **S3-compatible storage** (AWS S3 or DigitalOcean Spaces)
- **Git** installed on the machine
- **PM2** (for production process management)

---

## Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/Ayushd785/SnapDeploy.git
cd SnapDeploy
```

### 2. Configure environment variables

Copy `.env.example` to `.env` in each service and fill in your values:

```bash
cp vercel-upload-service/.env.example vercel-upload-service/.env
cp vercel-deploy-service/.env.example vercel-deploy-service/.env
cp vercel-request-handler/.env.example vercel-request-handler/.env
cp frontend/.env.example frontend/.env
```

#### Backend services `.env`

```env
# S3 / DigitalOcean Spaces
DO_SPACES_KEY=your_access_key
DO_SPACES_SECRET=your_secret_key
DO_SPACES_ENDPOINT=https://sfo3.digitaloceanspaces.com
DO_SPACES_BUCKET=your_bucket_name

# Redis
REDIS_URL=redis://localhost:6379
```

> Upload service also needs `PORT=3000`, request handler needs `PORT=3001`.

#### Frontend `.env`

```env
VITE_BACKEND_UPLOAD_URL=http://localhost:3000
VITE_REQUEST_HANDLER_DOMAIN=localhost:3001
```

### 3. Install dependencies

```bash
cd vercel-upload-service && npm install && cd ..
cd vercel-deploy-service && npm install && cd ..
cd vercel-request-handler && npm install && cd ..
cd frontend && npm install && cd ..
```

### 4. Run in development

Open 4 terminal windows:

```bash
# Terminal 1 — Upload Service
cd vercel-upload-service && npm run dev

# Terminal 2 — Deploy Service
cd vercel-deploy-service && npm run dev

# Terminal 3 — Request Handler
cd vercel-request-handler && npm run dev

# Terminal 4 — Frontend
cd frontend && npm run dev
```

### 5. Test it

1. Open `http://localhost:5173`
2. Paste a GitHub repo URL (e.g., a simple React app)
3. Click **Upload**
4. Wait for status to show **Deployed**
5. Visit the preview URL: `http://{id}.localhost:3001`

---

## Production Deployment (DigitalOcean Droplet)

### 1. Provision infrastructure

| Resource | Service | Purpose |
|----------|---------|---------|
| Droplet (Ubuntu) | DigitalOcean | Runs all services |
| Spaces bucket | DigitalOcean | S3-compatible object storage |
| Managed Redis | DigitalOcean | Message queue + status store |
| Domain | Any registrar | Wildcard subdomain routing |

### 2. Server setup

```bash
# SSH into droplet
ssh root@your-droplet-ip

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install Nginx
apt-get install -y nginx

# Install serve (for frontend static files)
npm install -g serve

# Clone the repo
git clone https://github.com/Ayushd785/SnapDeploy.git ~/SnapDeploy
```

### 3. Configure `.env` files

Set up `.env` in each service directory with your production values (Spaces keys, managed Redis URL, etc.)

### 4. Build & start all services

Use the included deploy script:

```bash
chmod +x ~/SnapDeploy/deploy.sh
~/SnapDeploy/deploy.sh
```

Or manually:

```bash
# Install deps + compile TypeScript + build frontend
cd ~/SnapDeploy/vercel-upload-service && npm install && npx tsc
cd ~/SnapDeploy/vercel-deploy-service && npm install && npx tsc
cd ~/SnapDeploy/vercel-request-handler && npm install && npx tsc
cd ~/SnapDeploy/frontend && npm install && npm run build

# Start with PM2
cd ~/SnapDeploy
pm2 start ecosystem.config.js
pm2 start "serve -s dist -l 5173" --name "frontend" --cwd ~/SnapDeploy/frontend
pm2 save
pm2 startup
```

### 5. Nginx configuration

#### Main app (frontend + API proxy)

```nginx
server {
    listen 80;
    server_name app.yourdomain.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_set_header Host $host;
    }

    location /deploy {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }

    location /status {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

#### Wildcard subdomain (deployed sites)

```nginx
server {
    listen 80;
    server_name *.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
# Test and reload Nginx
nginx -t
systemctl reload nginx
```

### 6. SSL with Certbot (optional)

```bash
apt-get install certbot python3-certbot-nginx
certbot --nginx -d app.yourdomain.com
# For wildcard: use DNS challenge
certbot certonly --manual --preferred-challenges dns -d "*.yourdomain.com"
```

### 7. DNS setup

| Record | Name | Value |
|--------|------|-------|
| A | `app` | `your-droplet-ip` |
| A | `*` | `your-droplet-ip` |

---

## Useful Commands

### PM2

```bash
pm2 list                    # List all running services
pm2 logs                    # Stream all logs
pm2 logs upload-service     # Logs for specific service
pm2 logs --lines 50         # Last 50 lines
pm2 monit                   # Real-time CPU/memory monitor
pm2 restart all             # Restart all services
pm2 restart upload-service  # Restart specific service
pm2 stop all                # Stop all services
pm2 delete all              # Stop and remove all services
pm2 save                    # Save process list for auto-start on reboot
pm2 startup                 # Generate startup script
pm2 flush                   # Clear all log files
```

### Recompile after code changes

```bash
cd ~/SnapDeploy/vercel-upload-service && npx tsc
cd ~/SnapDeploy/vercel-deploy-service && npx tsc
cd ~/SnapDeploy/vercel-request-handler && npx tsc
pm2 restart all
```

### Full redeploy from Git

```bash
~/SnapDeploy/deploy.sh
```

### Nginx

```bash
nginx -t                            # Test config syntax
systemctl reload nginx              # Reload without downtime
systemctl restart nginx             # Full restart
cat /var/log/nginx/error.log        # Error logs
cat /var/log/nginx/access.log       # Access logs
```

### Redis

```bash
redis-cli ping                      # Test local Redis
redis-cli -u "rediss://..." ping    # Test managed Redis (TLS)
redis-cli LLEN build-queue          # Check queue length
redis-cli HGETALL status            # See all deployment statuses
redis-cli KEYS "deployment:*"       # List all deployment timestamps
redis-cli FLUSHALL                  # ⚠️ Clear everything
```

### DigitalOcean Spaces (S3)

```bash
# Install AWS CLI (works with DO Spaces)
apt-get install awscli

# Configure
aws configure
# Access Key: your DO_SPACES_KEY
# Secret Key: your DO_SPACES_SECRET
# Region: us-east-1 (placeholder, doesn't matter)

# List bucket contents
aws s3 ls s3://your-bucket --endpoint-url https://sfo3.digitaloceanspaces.com

# List deployments
aws s3 ls s3://your-bucket/dist/ --endpoint-url https://sfo3.digitaloceanspaces.com

# Delete a specific deployment manually
aws s3 rm s3://your-bucket/dist/abc12/ --recursive --endpoint-url https://sfo3.digitaloceanspaces.com
aws s3 rm s3://your-bucket/output/abc12/ --recursive --endpoint-url https://sfo3.digitaloceanspaces.com
```

### Server monitoring

```bash
htop                                # CPU/memory usage
df -h                               # Disk usage
du -sh ~/SnapDeploy/*/output/       # Space used by cloned repos
free -h                             # RAM usage
```

---

## Project Structure

```
SnapDeploy/
├── frontend/                       # React + Vite + Tailwind + shadcn/ui
│   ├── src/
│   │   ├── components/
│   │   │   ├── landing.tsx         # Main UI — deploy form + status
│   │   │   └── ui/                 # shadcn/ui components (Button, Card, Input, Label)
│   │   ├── lib/utils.ts            # cn() utility for Tailwind class merging
│   │   ├── App.tsx                 # Root component
│   │   └── main.tsx                # React entry point
│   └── .env                        # VITE_BACKEND_UPLOAD_URL, VITE_REQUEST_HANDLER_DOMAIN
│
├── vercel-upload-service/          # Express API (port 3000)
│   └── src/
│       ├── index.ts                # POST /deploy, GET /status
│       ├── aws.ts                  # S3 upload function
│       ├── file.ts                 # Recursive directory walker
│       └── utils.ts                # Random ID generator
│
├── vercel-deploy-service/          # Headless build worker
│   └── src/
│       ├── index.ts                # BRPOP loop — download → build → upload → teardown
│       ├── aws.ts                  # S3 download, upload, delete functions
│       └── utils.ts                # buildProject() — exec npm install + build
│
├── vercel-request-handler/         # Express reverse proxy (port 3001)
│   └── src/
│       └── index.ts                # Subdomain routing, S3 file serving, expiry handling
│
├── ecosystem.config.js             # PM2 process configuration
├── deploy.sh                       # One-command production deployment script
├── study.md                        # Full architecture documentation
└── interviewques.md                # Technical interview Q&A
```

---

## License

MIT

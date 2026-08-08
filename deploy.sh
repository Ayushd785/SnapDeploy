#!/bin/bash
set -e

echo "=== Step 1: Stop and delete ALL PM2 processes ==="
pm2 delete all || true

echo "=== Step 2: Reset local changes and pull latest code ==="
cd ~/SnapDeploy
git reset --hard HEAD
git pull origin main

echo "=== Step 3: Clean old output and dist folders ==="
rm -rf vercel-upload-service/dist vercel-upload-service/src/output
rm -rf vercel-deploy-service/dist vercel-deploy-service/src/output
rm -rf vercel-request-handler/dist
rm -rf frontend/dist

echo "=== Step 4: Install dependencies ==="
cd ~/SnapDeploy/vercel-upload-service && npm install
cd ~/SnapDeploy/vercel-deploy-service && npm install
cd ~/SnapDeploy/vercel-request-handler && npm install
cd ~/SnapDeploy/frontend && npm install

echo "=== Step 5: Compile TypeScript & Build Frontend ==="
cd ~/SnapDeploy/vercel-upload-service && npx tsc
cd ~/SnapDeploy/vercel-deploy-service && npx tsc
cd ~/SnapDeploy/vercel-request-handler && npx tsc
cd ~/SnapDeploy/frontend && npm run build

echo "=== Step 6: Start all services with PM2 ==="
cd ~/SnapDeploy
pm2 start ecosystem.config.js
cd ~/SnapDeploy/frontend
pm2 start "serve -s dist -l 5173" --name "frontend"

echo "=== Step 7: Save PM2 process list ==="
pm2 save

echo ""
echo "=== ALL DONE! ==="
pm2 list

import express from "express";
import { S3 } from "aws-sdk";
import { createClient } from "redis";
import dotenv from "dotenv";
import mime from "mime-types";
dotenv.config();

const s3 = new S3({
    accessKeyId: process.env.DO_SPACES_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.DO_SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.DO_SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
    s3ForcePathStyle: false,
});

const BUCKET_NAME = process.env.DO_SPACES_BUCKET || "vercel";

const redisOptions = process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
    socket: {
        ...(process.env.REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : {}),
        reconnectStrategy: (retries: number) => {
            return Math.min(retries * 500, 30000);
        }
    }
} : {};

let isRedisConnected = false;
let redisErrorLogged = false;
const redis = createClient(redisOptions);
redis.on('error', (err) => {
    isRedisConnected = false;
    if (!redisErrorLogged) {
        console.error('Redis Client Error:', err.message || 'Connection refused');
        console.error('Redis reconnection will continue silently in background...');
        redisErrorLogged = true;
    }
});
redis.on('ready', () => {
    isRedisConnected = true;
    if (redisErrorLogged) {
        console.log('Redis reconnected successfully.');
        redisErrorLogged = false;
    }
});

redis.connect().then(() => {
    isRedisConnected = true;
}).catch((err) => {
    isRedisConnected = false;
    console.error('Redis Connect Error:', err.message);
});

async function deleteS3Folder(prefix: string) {
    try {
        const listedObjects = await s3.listObjectsV2({
            Bucket: BUCKET_NAME,
            Prefix: prefix
        }).promise();

        if (!listedObjects.Contents || listedObjects.Contents.length === 0) return;

        const deleteParams = {
            Bucket: BUCKET_NAME,
            Delete: { Objects: listedObjects.Contents.map(({ Key }) => ({ Key: Key! })) }
        };

        await s3.deleteObjects(deleteParams).promise();
        if (listedObjects.IsTruncated) {
            await deleteS3Folder(prefix);
        }
        console.log(`[Request-Handler S3 Purge] Purged ${prefix}`);
    } catch (err) {
        console.error(`[Request-Handler S3 Purge Error] Failed for ${prefix}:`, err);
    }
}

function getExpiredHtmlResponse() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Deployment Expired | SnapDeploy</title>
            <style>
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #090d16; color: #f8fafc; text-align: center; padding: 1rem; }
                .container { max-width: 480px; width: 100%; padding: 2.5rem 2rem; border-radius: 16px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(12px); box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.5); }
                .icon { font-size: 3rem; margin-bottom: 1rem; display: inline-block; }
                h1 { color: #f43f5e; font-size: 1.75rem; margin: 0 0 0.75rem 0; font-weight: 700; letter-spacing: -0.025em; }
                p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin: 0 0 1.5rem 0; }
                .badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; background: rgba(244, 63, 94, 0.1); color: #f43f5e; border-radius: 20px; font-weight: 600; font-size: 0.8rem; border: 1px solid rgba(244, 63, 94, 0.2); }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="icon">⌛</div>
                <h1>Deployment Expired</h1>
                <p>This temporary site deployment has reached its <strong>5-minute lifetime limit</strong> and has been automatically taken down.</p>
                <div class="badge">SnapDeploy Teardown Engine</div>
            </div>
        </body>
        </html>
    `;
}

const app = express();
app.set("trust proxy", true);

app.get("/*", async (req, res) => {
    const host = (req.headers.host || req.hostname || "").split(":")[0];
    const id = host.split(".")[0];

    let filePath = req.path;
    if (filePath === "/") {
        filePath = "/index.html";
    }

    try {
        let status = null;
        let createdAtStr = null;

        if (isRedisConnected) {
            try {
                status = await redis.hGet("status", id);
                createdAtStr = await redis.get(`deployment:${id}:created_at`);
            } catch (rErr) {
                console.error(`[Redis Read Error] for deployment [${id}]:`, rErr);
            }
        }
        
        let isExpiredByTime = false;
        if (createdAtStr) {
            const createdAt = parseInt(createdAtStr, 10);
            if (Date.now() - createdAt > 5 * 60 * 1000) {
                isExpiredByTime = true;
            }
        }

        if (status === "expired" || isExpiredByTime) {
            if (status !== "expired" && isRedisConnected) {
                try {
                    await redis.hSet("status", id, "expired");
                } catch (e) {}
                deleteS3Folder(`output/${id}`);
                deleteS3Folder(`dist/${id}`);
            }
            return res.status(410).send(getExpiredHtmlResponse());
        }

        const key = `dist/${id}${filePath}`;
        console.log(`[Request-Handler] Fetching S3 key: ${key} for host: ${host}`);

        const contents = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: key
        }).promise();
        
        const type = mime.lookup(filePath) || "application/octet-stream";
        res.set("Content-Type", type);
        res.send(contents.Body);
    } catch (e: any) {
        console.error(`Error fetching object from S3 for deployment [${id}], path [${filePath}]:`, e?.message || e);
        res.status(404).send("File not found or deployment in progress.");
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Request handler running on port ${PORT}`);
});
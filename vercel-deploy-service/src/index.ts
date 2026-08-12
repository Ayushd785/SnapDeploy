import { createClient } from "redis";
import { copyFinalDist, downloadS3Folder, deleteS3Folder } from "./aws";
import { buildProject } from "./utils";
import { sendDeploySuccessEmail, sendDeployFailureEmail } from "./emailService/recendConfig";
import dotenv from "dotenv";
dotenv.config();

const redisOptions = process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
    socket: {
        ...(process.env.REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : {}),
        keepAlive: 10000,
        connectTimeout: 10000,
        reconnectStrategy: (retries: number) => {
            if (retries === 1) console.log('Redis disconnected. Reconnecting...');
            return Math.min(retries * 500, 10000);
        }
    },
    pingInterval: 30000
} : {};

let subErrorLogged = false, pubErrorLogged = false;
const subscriber = createClient(redisOptions);
subscriber.on('error', (err) => { if (!subErrorLogged) { console.error('Redis Subscriber Error:', err.message || 'Connection refused'); subErrorLogged = true; } });
subscriber.on('ready', () => { subErrorLogged = false; });

const publisher = createClient(redisOptions);
publisher.on('error', (err) => { if (!pubErrorLogged) { console.error('Redis Publisher Error:', err.message || 'Connection refused'); pubErrorLogged = true; } });
publisher.on('ready', () => { pubErrorLogged = false; });

const EXPIRY_SECONDS = 300;

async function main() {
    // Wait for both Redis clients to connect before starting
    await subscriber.connect();
    console.log("Redis subscriber connected.");
    await publisher.connect();
    console.log("Redis publisher connected.");

    console.log("Deploy service worker listening on queue...");
    while (1) {
        try {
            // Use finite timeout (30s) to avoid idle connection kills by managed Redis
            const res = await subscriber.brPop('build-queue', 30);
            if (!res) continue; // Timeout with no job — loop back and poll again

            const id = res.element;
            console.log(`[${id}] === START: Processing build job ===`);

            console.log(`[${id}] Step 1: Downloading files from S3...`);
            await downloadS3Folder(`output/${id}`);
            console.log(`[${id}] Step 2: Download complete. Starting build...`);

            const buildSuccess = await buildProject(id);
            console.log(`[${id}] Step 3: Build finished. Success: ${buildSuccess}`);

            // Retrieve user email stored by upload-service
            const email = await publisher.hGet("deploy-email", id);
            console.log(`[${id}] Email lookup: "${email || '(none)'}"`);

            if (buildSuccess) {
                console.log(`[${id}] Step 4: Uploading dist folder to S3...`);
                await copyFinalDist(id);
                await publisher.hSet("status", id, "deployed");
                // Store deployment creation timestamp in Redis
                await publisher.set(`deployment:${id}:created_at`, Date.now().toString());
                console.log(`[${id}] === DONE: Successfully deployed (Active for ${EXPIRY_SECONDS} seconds) ===`);

                // Send success email with deployed URL
                if (email) {
                    const deployedUrl = `http://${id}.${process.env.DEPLOY_DOMAIN || 'localhost:3001'}`;
                    console.log(`[${id}] Sending success email to ${email}...`);
                    await sendDeploySuccessEmail(email, id, deployedUrl);
                    console.log(`[${id}] Email send completed.`);
                } else {
                    console.log(`[${id}] No email found in Redis — skipping notification.`);
                }

                // Schedule background cleanup in 5 minutes
                setTimeout(async () => {
                    console.log(`[${id}] 5 minutes lifetime limit reached. Purging deployment...`);
                    await publisher.hSet("status", id, "expired");
                    await deleteS3Folder(`output/${id}`);
                    await deleteS3Folder(`dist/${id}`);
                    console.log(`[${id}] Purge complete. Site taken down.`);
                }, EXPIRY_SECONDS * 1000);
            } else {
                await publisher.hSet("status", id, "failed");
                console.log(`[${id}] === DONE: Build FAILED ===`);

                // Send failure email
                if (email) {
                    await sendDeployFailureEmail(email, id);
                }
            }
        } catch (err: any) {
            console.error("Error processing build job:", err?.message || err);
            // Back off before retrying to avoid tight crash loops
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

main();


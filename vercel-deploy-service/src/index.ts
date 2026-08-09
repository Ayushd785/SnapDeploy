import { createClient, commandOptions } from "redis";
import { copyFinalDist, downloadS3Folder, deleteS3Folder } from "./aws";
import { buildProject } from "./utils";
import dotenv from "dotenv";
dotenv.config();

const redisOptions = process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
    socket: {
        ...(process.env.REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : {}),
        reconnectStrategy: (retries: number) => {
            if (retries === 1) console.log('Redis disconnected. Reconnecting silently...');
            return Math.min(retries * 500, 30000);
        }
    }
} : {};

let subErrorLogged = false, pubErrorLogged = false;
const subscriber = createClient(redisOptions);
subscriber.on('error', (err) => { if (!subErrorLogged) { console.error('Redis Subscriber Error:', err.message || 'Connection refused'); subErrorLogged = true; } });
subscriber.on('ready', () => { subErrorLogged = false; });
subscriber.connect();

const publisher = createClient(redisOptions);
publisher.on('error', (err) => { if (!pubErrorLogged) { console.error('Redis Publisher Error:', err.message || 'Connection refused'); pubErrorLogged = true; } });
publisher.on('ready', () => { pubErrorLogged = false; });
publisher.connect();

const EXPIRY_SECONDS = 300; // 5 minutes

async function main() {
    console.log("Deploy service worker listening on queue...");
    while(1) {
        try {
            const res = await subscriber.brPop(
                commandOptions({ isolated: true }),
                'build-queue',
                0
              );
            // @ts-ignore;
            const id = res.element
            console.log(`[${id}] === START: Processing build job ===`);
            
            console.log(`[${id}] Step 1: Downloading files from S3...`);
            await downloadS3Folder(`output/${id}`);
            console.log(`[${id}] Step 2: Download complete. Starting build...`);
            
            const buildSuccess = await buildProject(id);
            console.log(`[${id}] Step 3: Build finished. Success: ${buildSuccess}`);
            
            if (buildSuccess) {
                console.log(`[${id}] Step 4: Uploading dist folder to S3...`);
                await copyFinalDist(id);
                await publisher.hSet("status", id, "deployed");
                // Store deployment creation timestamp in Redis
                await publisher.set(`deployment:${id}:created_at`, Date.now().toString());
                console.log(`[${id}] === DONE: Successfully deployed (Active for ${EXPIRY_SECONDS} seconds) ===`);

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
            }
        } catch (err) {
            console.error("Error processing build job:", err);
        }
    }
}

main();


import { createClient, commandOptions } from "redis";
import { copyFinalDist, downloadS3Folder } from "./aws";
import { buildProject } from "./utils";
import dotenv from "dotenv";
dotenv.config();

const redisOptions = process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
    socket: {
        ...(process.env.REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : {}),
        reconnectStrategy: (retries: number) => {
            console.log(`Redis reconnecting... attempt ${retries}`);
            return Math.min(retries * 100, 3000);
        }
    }
} : {};

const subscriber = createClient(redisOptions);
subscriber.on('error', (err) => console.error('Redis Subscriber Error:', err.message));
subscriber.connect();

const publisher = createClient(redisOptions);
publisher.on('error', (err) => console.error('Redis Publisher Error:', err.message));
publisher.connect();

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
            console.log(`Processing build job for deployment ID: ${id}`);
            
            await downloadS3Folder(`output/${id}`);
            const buildSuccess = await buildProject(id);
            
            if (buildSuccess) {
                copyFinalDist(id);
                publisher.hSet("status", id, "deployed");
                console.log(`Successfully deployed ${id}`);
            } else {
                publisher.hSet("status", id, "failed");
                console.log(`Build failed for ${id}`);
            }
        } catch (err) {
            console.error("Error processing build job:", err);
        }
    }
}
main();


import { createClient, commandOptions } from "redis";
import { copyFinalDist, downloadS3Folder } from "./aws";
import { buildProject } from "./utils";
import dotenv from "dotenv";
dotenv.config();

const redisOptions = process.env.REDIS_URL ? {
    url: process.env.REDIS_URL,
    socket: process.env.REDIS_URL.startsWith("rediss://") ? { rejectUnauthorized: false } : {}
} : {};
const subscriber = createClient(redisOptions);
subscriber.connect();

const publisher = createClient(redisOptions);
publisher.connect();

async function main() {
    console.log("Deploy service worker listening on queue...");
    while(1) {
        const res = await subscriber.brPop(
            commandOptions({ isolated: true }),
            'build-queue',
            0
          );
        // @ts-ignore;
        const id = res.element
        console.log(`Processing build job for deployment ID: ${id}`);
        
        await downloadS3Folder(`output/${id}`)
        await buildProject(id);
        copyFinalDist(id);
        publisher.hSet("status", id, "deployed")
        console.log(`Successfully deployed ${id}`);
    }
}
main();


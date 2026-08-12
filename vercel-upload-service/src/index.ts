import express from "express";
import cors from "cors";
import simpleGit from "simple-git";
import { generate } from "./utils";
import { getAllFiles } from "./file";
import path from "path";
import { uploadFile } from "./aws";
import { createClient } from "redis";
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

let pubErrorLogged = false, subErrorLogged = false;
const publisher = createClient(redisOptions);
publisher.on('error', (err) => { if (!pubErrorLogged) { console.error('Redis Publisher Error:', err.message || 'Connection refused'); pubErrorLogged = true; } });
publisher.on('ready', () => { pubErrorLogged = false; });
publisher.connect();

const subscriber = createClient(redisOptions);
subscriber.on('error', (err) => { if (!subErrorLogged) { console.error('Redis Subscriber Error:', err.message || 'Connection refused'); subErrorLogged = true; } });
subscriber.on('ready', () => { subErrorLogged = false; });
subscriber.connect();

const app = express();
app.use(cors())
app.use(express.json());

app.post("/deploy", async (req, res) => {
    const repoUrl = req.body.repoUrl;
    const email = req.body.email;
    const id = generate(); // asd12
    console.log(`[${id}] Cloning repo: ${repoUrl}`);
    await simpleGit().clone(repoUrl, path.join(__dirname, `output/${id}`));
    console.log(`[${id}] Clone complete`);

    const files = getAllFiles(path.join(__dirname, `output/${id}`));
    console.log(`[${id}] Found ${files.length} files to upload`);

    await Promise.all(files.map(file => uploadFile(file.slice(__dirname.length + 1), file)));
    console.log(`[${id}] All files uploaded to S3`);

    await publisher.lPush("build-queue", id);
    await publisher.hSet("status", id, "uploaded");
    if (email) {
        await publisher.hSet("deploy-email", id, email);
        console.log(`[${id}] Email ${email} stored for notifications`);
    }
    console.log(`[${id}] Pushed to build-queue and set status to uploaded`);

    res.json({
        id: id
    })

});

app.get("/status", async (req, res) => {
    const id = req.query.id;
    const response = await subscriber.hGet("status", id as string);
    res.json({
        status: response
    })
})

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Upload service running on port ${PORT}`);
});


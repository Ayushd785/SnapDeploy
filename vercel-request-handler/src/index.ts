import express from "express";
import { S3 } from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();

const s3 = new S3({
    accessKeyId: process.env.DO_SPACES_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.DO_SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.DO_SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
    s3ForcePathStyle: false,
});

const BUCKET_NAME = process.env.DO_SPACES_BUCKET || "vercel";

const app = express();

app.get("/*", async (req, res) => {
    // e.g. id.yourdomain.com
    const host = req.hostname;

    const id = host.split(".")[0];
    let filePath = req.path;
    if (filePath === "/") {
        filePath = "/index.html";
    }

    try {
        const contents = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: `dist/${id}${filePath}`
        }).promise();
        
        const type = filePath.endsWith("html") ? "text/html" : filePath.endsWith("css") ? "text/css" : filePath.endsWith("svg") ? "image/svg+xml" : filePath.endsWith("png") ? "image/png" : "application/javascript";
        res.set("Content-Type", type);
        res.send(contents.Body);
    } catch (e) {
        console.error("Error fetching object from S3:", e);
        res.status(404).send("File not found or deployment in progress.");
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Request handler running on port ${PORT}`);
});
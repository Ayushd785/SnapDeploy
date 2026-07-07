import { S3 } from "aws-sdk";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const s3 = new S3({
    accessKeyId: process.env.DO_SPACES_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.DO_SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.DO_SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
    s3ForcePathStyle: false,
});

const BUCKET_NAME = process.env.DO_SPACES_BUCKET || "vercel";

// fileName => output/12312/src/App.jsx
// filePath => /Users/harkiratsingh/vercel/dist/output/12312/src/App.jsx
export const uploadFile = async (fileName: string, localFilePath: string) => {
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: BUCKET_NAME,
        Key: fileName,
    }).promise();
    console.log(response);
}
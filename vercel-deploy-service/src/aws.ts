import { S3 } from "aws-sdk";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const s3 = new S3({
    accessKeyId: process.env.DO_SPACES_KEY || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.DO_SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY,
    endpoint: process.env.DO_SPACES_ENDPOINT || "https://nyc3.digitaloceanspaces.com",
    s3ForcePathStyle: false,
});

const BUCKET_NAME = process.env.DO_SPACES_BUCKET || "vercel";

// output/asdasd
export async function downloadS3Folder(prefix: string) {
    const allFiles = await s3.listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: prefix
    }).promise();
    
    const allPromises = allFiles.Contents?.map(async ({Key}) => {
        return new Promise((resolve) => {
            if (!Key) {
                resolve("");
                return;
            }
            const finalOutputPath = path.join(__dirname, Key);
            const dirName = path.dirname(finalOutputPath);
            if (!fs.existsSync(dirName)){
                fs.mkdirSync(dirName, { recursive: true });
            }
            const outputFile = fs.createWriteStream(finalOutputPath);
            const stream = s3.getObject({
                Bucket: BUCKET_NAME,
                Key
            }).createReadStream();

            stream.pipe(outputFile);

            stream.on("error", (err) => {
                console.error(`S3 Download stream error for ${Key}:`, err.message);
                resolve("");
            });

            outputFile.on("finish", () => {
                resolve("");
            });

            outputFile.on("error", (err) => {
                console.error(`Write file error for ${finalOutputPath}:`, err.message);
                resolve("");
            });
        })
    }) || [];
    
    console.log(`Downloading ${allPromises.length} files from S3...`);
    await Promise.all(allPromises);
    console.log("Download complete.");
}

export async function copyFinalDist(id: string) {
    const folderPath = path.join(__dirname, `output/${id}/dist`);
    if (!fs.existsSync(folderPath)) {
        console.error(`Dist folder does not exist at ${folderPath}`);
        return;
    }
    const allFiles = getAllFiles(folderPath);
    const allPromises = allFiles.map(file => {
        return uploadFile(`dist/${id}/` + file.slice(folderPath.length + 1), file);
    });
    await Promise.all(allPromises);
}

const getAllFiles = (folderPath: string) => {
    let response: string[] = [];

    const allFilesAndFolders = fs.readdirSync(folderPath);
    allFilesAndFolders.forEach(file => {
        const fullFilePath = path.join(folderPath, file);
        if (fs.statSync(fullFilePath).isDirectory()) {
            response = response.concat(getAllFiles(fullFilePath))
        } else {
            response.push(fullFilePath);
        }
    });
    return response;
}

const uploadFile = async (fileName: string, localFilePath: string) => {
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: BUCKET_NAME,
        Key: fileName,
    }).promise();
    console.log(response);
}

export async function deleteS3Folder(prefix: string) {
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
        console.log(`[S3 Purge] Deleted objects under prefix: ${prefix}`);
    } catch (err) {
        console.error(`[S3 Purge Error] Failed deleting prefix ${prefix}:`, err);
    }
}
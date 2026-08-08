module.exports = {
  apps: [
    {
      name: "upload-service",
      cwd: "./vercel-upload-service",
      script: "npx",
      args: "ts-node src/index.ts",
      node_args: "--max-old-space-size=256",
    },
    {
      name: "deploy-service",
      cwd: "./vercel-deploy-service",
      script: "npx",
      args: "ts-node src/index.ts",
      node_args: "--max-old-space-size=256",
    },
    {
      name: "request-handler",
      cwd: "./vercel-request-handler",
      script: "npx",
      args: "ts-node src/index.ts",
      node_args: "--max-old-space-size=256",
    }
  ]
};

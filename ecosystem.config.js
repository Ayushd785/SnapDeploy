module.exports = {
  apps: [
    {
      name: "upload-service",
      cwd: "./vercel-upload-service",
      script: "node",
      args: "dist/index.js",
      node_args: "--max-old-space-size=256",
    },
    {
      name: "deploy-service",
      cwd: "./vercel-deploy-service",
      script: "node",
      args: "dist/index.js",
      node_args: "--max-old-space-size=256",
    },
    {
      name: "request-handler",
      cwd: "./vercel-request-handler",
      script: "node",
      args: "dist/index.js",
      node_args: "--max-old-space-size=256",
    }
  ]
};

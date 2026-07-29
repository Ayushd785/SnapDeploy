module.exports = {
  apps: [
    {
      name: "upload-service",
      cwd: "./vercel-upload-service",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "deploy-service",
      cwd: "./vercel-deploy-service",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "request-handler",
      cwd: "./vercel-request-handler",
      script: "npm",
      args: "start",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

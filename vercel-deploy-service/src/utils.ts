import { exec, spawn } from "child_process";
import path from "path";

export function buildProject(id: string): Promise<boolean> {
    return new Promise((resolve) => {
        const projectDir = path.join(__dirname, `output/${id}`);
        const child = exec(`cd ${projectDir} && NODE_ENV=development npm install --legacy-peer-deps && npm run build`)

        child.stdout?.on('data', function(data) {
            console.log('stdout: ' + data);
        });
        child.stderr?.on('data', function(data) {
            console.log('stderr: ' + data);
        });

        child.on('close', function(code) {
           resolve(code === 0);
        });
    })
}
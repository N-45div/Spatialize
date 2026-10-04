import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = Number(process.env.SPATIALIZE_DEV_API_PORT || 8788);
const webPort = Number(process.env.SPATIALIZE_DEV_PORT || 4174);
if (![apiPort, webPort].every(port => Number.isInteger(port) && port > 1024 && port <= 65535)) {
  throw new Error("Choose valid development ports between 1025 and 65535");
}
const python = process.env.SPATIALIZE_PYTHON;
const command = python || (process.platform === "win32" ? "uv.exe" : "uv");
const args = python ? ["-m", "uvicorn"] : ["run", "uvicorn"];
const api = spawn(command, [...args, "spatialize_api.app:create_app", "--factory", "--port", String(apiPort)], {
  cwd: path.join(root, "backend"), stdio: "inherit", windowsHide: true
});
const web = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "--port", String(webPort), "--strictPort"], {
  cwd: root, stdio: "inherit", windowsHide: true,
  env: { ...process.env, SPATIALIZE_DEV_API_URL: `http://127.0.0.1:${apiPort}` }
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; api.kill(); web.kill(); process.exitCode = code;
}
for (const child of [api, web]) {
  child.on("error", error => { console.error(error.message); stop(1); });
  child.on("exit", code => stop(code || 0));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
console.log(`Access desk: http://localhost:${webPort}/#studio`);

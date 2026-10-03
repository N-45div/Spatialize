import { defineConfig } from "@playwright/test";
import path from "node:path";

const python = process.env.SPATIALIZE_TEST_PYTHON;
export default defineConfig({
  testDir: "./tests/browser", fullyParallel: false, workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:4174", viewport: { width: 1440, height: 1000 },
    channel: "chrome", screenshot: "only-on-failure", trace: "retain-on-failure",
    launchOptions: { args: ["--enable-unsafe-swiftshader"] } },
  webServer: [
    { command: python ? `"${python}" -m uvicorn spatialize_api.app:create_app --factory --port 8788` :
        "uv run uvicorn spatialize_api.app:create_app --factory --port 8788",
      cwd: "backend", url: "http://127.0.0.1:8788/health", reuseExistingServer: false,
      env: { SPATIALIZE_STORAGE_BACKEND: "local", SPATIALIZE_LOCAL_DATA_DIR: path.resolve("backend/.local-data-e2e"),
        OPENAI_API_KEY: "", GEMINI_API_KEY: "", OPENROUTER_API_KEY: "", ASSEMBLYAI_API_KEY: "", SARVAM_API_KEY: "",
        SANITY_PROJECT_ID: "", SANITY_CONTEXT_URL: "", SANITY_CONTEXT_TOKEN: "", SPATIALIZE_VENUE_TOKEN: "" } },
    { command: "npm run dev -- --port 4174 --strictPort", url: "http://127.0.0.1:4174", reuseExistingServer: false,
      env: { SPATIALIZE_DEV_API_URL: "http://127.0.0.1:8788", VITE_API_BASE_URL: "" } }
  ]
});

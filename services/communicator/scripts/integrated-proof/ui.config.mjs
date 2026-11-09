import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(
  new URL("../../apps/control-plane/package.json", import.meta.url),
);
const { defineConfig } = require("@playwright/test");
const app = fileURLToPath(new URL("../../apps/control-plane", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.mjs",
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir:
    process.env.COMMUNICATOR_PROOF_UI_DIR ??
    "/tmp/communicator-integrated-ui-proof",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    video: process.env.COMMUNICATOR_PROOF_RECORD
      ? { mode: "on", size: { width: 1280, height: 900 } }
      : "off",
    launchOptions: { executablePath: process.env.COMMUNICATOR_PROOF_CHROME },
  },
  webServer: {
    command:
      "VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    cwd: app,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "VITE_DEPLOYMENT_ENV=local VITE_DATA_MODE=simulated pnpm vite --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    cwd: ".",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

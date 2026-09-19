import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testSecrets = {
  GOOGLE_CLIENT_SECRET: "test-only-google-client-secret",
  GITHUB_CLIENT_SECRET: "test-only-github-client-secret",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-with-at-least-32-chars",
};
Object.assign(process.env, testSecrets);

export default defineConfig(async () => {
  const identityMigrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );
  const fixtureMigrations = await readD1Migrations(
    fileURLToPath(
      new URL("./worker/test/fixtures/migrations", import.meta.url),
    ),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            PLATFORM_BASE_URL: "http://localhost",
            PLATFORM_DEPLOYMENT_MODE: "self-hosted",
            PLATFORM_SIGNUP_POLICY: "open",
            PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
            ...testSecrets,
            TEST_MIGRATIONS: identityMigrations,
            TEST_FIXTURE_MIGRATIONS: fixtureMigrations,
          },
        },
      }),
    ],
    test: {
      include: ["worker/test/**/*.test.ts"],
      setupFiles: ["./worker/test/setup.ts"],
      pool: "workers",
    },
  };
});

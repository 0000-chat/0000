import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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

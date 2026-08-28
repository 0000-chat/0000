import type { D1Migration } from "@cloudflare/vitest-plugin";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach } from "vitest";

type TestEnv = Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  const testEnv = env as TestEnv;
  await applyD1Migrations(testEnv.CONTROL_DB, testEnv.TEST_MIGRATIONS);
});

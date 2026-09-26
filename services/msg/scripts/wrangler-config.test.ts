import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { createMsgWranglerConfig, resolveMsgWranglerArguments, validateMsgD1DatabaseId } from "./wrangler-config";

test("creates a production config only from a validated D1 database id", () => {
  const config = createMsgWranglerConfig("11111111-2222-4333-8444-555555555555");

  expect(config).toContain('"database_id": "11111111-2222-4333-8444-555555555555"');
  expect(config).toContain('"pattern": "msg.0000.chat"');
  expect(config).toContain("worker/src/worker-entry.ts");
  expect(config).toContain("worker/migrations");
  expect(config).toContain("worker/public");
  expect(config).not.toContain("__MSG_D1_DATABASE_ID__");
});

test("uses a compatibility date that Cloudflare accepts on the current UTC day", () => {
  const config = JSON.parse(createMsgWranglerConfig("11111111-2222-4333-8444-555555555555")) as {
    compatibility_date: string;
  };
  const currentUtcDate = new Date().toISOString().slice(0, 10);

  expect(config.compatibility_date <= currentUtcDate).toBe(true);
});

test("configures separate one-minute production rate-limit bindings", () => {
  const config = JSON.parse(createMsgWranglerConfig("11111111-2222-4333-8444-555555555555")) as {
    ratelimits?: readonly { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  };

  expect(config.ratelimits).toEqual([
    { name: "MSG_RATE_LIMIT_CREATION", namespace_id: "2026080901", simple: { limit: 6, period: 60 } },
    { name: "MSG_RATE_LIMIT_READS", namespace_id: "2026080902", simple: { limit: 60, period: 60 } },
    { name: "MSG_RATE_LIMIT_POSTS", namespace_id: "2026080903", simple: { limit: 20, period: 60 } },
    { name: "MSG_RATE_LIMIT_LIVE", namespace_id: "2026080904", simple: { limit: 10, period: 60 } },
  ]);
});

test("rejects placeholders and malformed D1 database ids", () => {
  for (const value of ["", "__MSG_D1_DATABASE_ID__", "not-a-database-id", "11111111-2222-4333-8444-55555555555z"]) {
    expect(() => validateMsgD1DatabaseId(value)).toThrow("MSG_D1_DATABASE_ID");
  }
});

test("resolves Wrangler type output relative to the service despite the monorepo command cwd", () => {
  const target = fileURLToPath(new URL("../worker/worker-configuration.d.ts", import.meta.url));
  expect(resolveMsgWranglerArguments(["types", "worker/worker-configuration.d.ts", "--include-runtime=true"])).toEqual([
    "types",
    target,
    "--include-runtime=true",
  ]);
  expect(resolveMsgWranglerArguments(["deploy", "--dry-run"])).toEqual(["deploy", "--dry-run"]);
});

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import {
  buildPlatformMiniflareRateLimits,
  buildPlatformTestRateLimitPolicy,
} from "../../../platform/src/rate-limit-policy.js";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );
  const composition = process.env.COMMUNICATOR_SAVED_SEND_COMPOSITION === "1";
  let platformScript = "";
  if (composition) {
    const scratch = mkdtempSync(join(tmpdir(), "communicator-saved-platform-"));
    try {
      const output = join(scratch, "platform.mjs");
      execFileSync(
        "bun",
        [
          "build",
          fileURLToPath(
            new URL(
              "./worker/test/fixtures/saved-platform.mjs",
              import.meta.url,
            ),
          ),
          "--target=browser",
          "--external=cloudflare:*",
          "--external=node:*",
          `--outfile=${output}`,
        ],
        { stdio: "pipe" },
      );
      platformScript = readFileSync(output, "utf8");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const platformMigrations = composition
    ? await readD1Migrations(
        fileURLToPath(new URL("../../../platform/migrations", import.meta.url)),
      )
    : [];

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_PLATFORM_MIGRATIONS: platformMigrations,
          },
          ...(composition
            ? { d1Databases: { TEST_PLATFORM_DB: "saved-send-platform-db" } }
            : {}),
          serviceBindings: {
            TEST_OUTBOUND_PROVIDER: "controlled-outbound-provider",
            ...(composition ? { TEST_PLATFORM: "saved-send-platform" } : {}),
          },
          workers: [
            ...(composition
              ? [
                  {
                    name: "saved-send-platform",
                    modules: true,
                    compatibilityDate: "2026-08-25",
                    compatibilityFlags: ["nodejs_compat"],
                    script: platformScript,
                    d1Databases: { IDENTITY_DB: "saved-send-platform-db" },
                    ratelimits: buildPlatformMiniflareRateLimits(
                      buildPlatformTestRateLimitPolicy(),
                    ),
                    bindings: {
                      PLATFORM_BASE_URL: "http://localhost",
                      PLATFORM_AUTHORITY_ID: "saved-send-test-authority",
                      PLATFORM_DEPLOYMENT_MODE: "self-hosted",
                      PLATFORM_SIGNUP_POLICY: "open",
                      PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
                      PLATFORM_SERVER_DEADLINE_MS: "8000",
                      PLATFORM_RATE_LIMIT_POLICY: "",
                      BETTER_AUTH_SECRET:
                        "saved-send-test-only-secret-at-least-32-characters",
                    },
                  },
                ]
              : []),
            {
              name: "controlled-outbound-provider",
              modules: true,
              compatibilityDate: "2026-08-25",
              script: `
              const calls = new Map();
              export default {
                async fetch(request) {
                  const url = new URL(request.url);
                  if (request.method === 'POST' && url.pathname === '/send') {
                    const payload = await request.json();
                    calls.set(payload.command_id, (calls.get(payload.command_id) ?? 0) + 1);
                    return new Response('accepted', { status: 202 });
                  }
                  return Response.json(calls.get(url.searchParams.get('command_id')) ?? 0);
                }
              };
            `,
            },
          ],
        },
      }),
    ],
    test: {
      include: [
        composition
          ? "worker/test/outbound/saved-send.composition.ts"
          : "worker/test/**/*.test.ts",
      ],
      setupFiles: ["./worker/test/setup.ts"],
    },
  };
});

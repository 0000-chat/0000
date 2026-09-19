import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  buildPlatformMiniflareRateLimits,
  validatePlatformRateLimitPolicy,
} from "../src/rate-limit-policy.ts";

const workerEntry = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
const compatibilityDate = "2026-09-18";
const policy = validatePlatformRateLimitPolicy({
  login: { limit: 2, namespace_id: "2026092001" },
  issuance: { limit: 2, namespace_id: "2026092002" },
  management: { limit: 2, namespace_id: "2026092003" },
  verification: { limit: 2, namespace_id: "2026092004" },
  guestControl: { limit: 2, namespace_id: "2026092005" },
});

const wrapper = `
import platformWorker from ${JSON.stringify(workerEntry)};

function wrapDatabase(database, record) {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query) => {
          record.databasePrepares += 1;
          return target.prepare(query);
        };
      }
      if (property === "withSession") {
        return (constraint) => wrapDatabase(target.withSession(constraint), record);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const record = { bodyClones: 0, databasePrepares: 0 };
    const originalClone = Request.prototype.clone;
    Request.prototype.clone = function () {
      record.bodyClones += 1;
      return originalClone.call(this);
    };
    const trackedEnv = Object.create(env);
    trackedEnv.IDENTITY_DB = wrapDatabase(env.IDENTITY_DB, record);
    try {
      const response = await platformWorker.fetch(request, trackedEnv, ctx);
      const headers = new Headers(response.headers);
      headers.set("x-platform-test-body-clones", String(record.bodyClones));
      headers.set("x-platform-test-database-prepares", String(record.databasePrepares));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } finally {
      Request.prototype.clone = originalClone;
    }
  },
};
`;
const wrapperPath = join(
  tmpdir(),
  `platform-t12-native-wrapper-${process.pid}.mjs`,
);
await writeFile(wrapperPath, wrapper);
const result = await Bun.build({
  entrypoints: [wrapperPath],
  external: ["cloudflare:workers"],
  format: "esm",
  naming: "worker.js",
  target: "browser",
});
await rm(wrapperPath, { force: true });
if (!result.success) {
  throw new Error(
    `Platform boundary worker bundle failed: ${result.logs
      .map((log) => log.message)
      .join("\n")}`,
  );
}
const output = result.outputs.find((entry) => entry.kind === "entry-point");
if (!output) throw new Error("Platform boundary worker bundle was not emitted");
const workerScript = await output.text();

const bindings = {
  PLATFORM_BASE_URL: "http://localhost",
  PLATFORM_AUTHORITY_ID: "platform-t12-native-boundary",
  PLATFORM_CREDENTIAL_MAX_LIFETIME_DAYS: "90",
  PLATFORM_SERVER_DEADLINE_MS: "8000",
  PLATFORM_RATE_LIMIT_POLICY: "",
  PLATFORM_DEPLOYMENT_MODE: "self-hosted",
  PLATFORM_SIGNUP_POLICY: "open",
  GITHUB_CLIENT_ID: "platform-t12-native-client",
  GITHUB_CLIENT_SECRET: "platform-t12-native-secret",
  BETTER_AUTH_SECRET:
    "platform-t12-native-secret-that-is-long-enough-for-tests",
};

const miniflare = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "platform-native-a",
        compatibilityDate,
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        script: workerScript,
        bindings,
        d1Databases: { IDENTITY_DB: "platform-native-boundary-db" },
        ratelimits: buildPlatformMiniflareRateLimits(policy),
      },
      {
        name: "platform-native-b",
        compatibilityDate,
        compatibilityFlags: ["nodejs_compat"],
        modules: true,
        script: workerScript,
        bindings,
        d1Databases: { IDENTITY_DB: "platform-native-boundary-db" },
        ratelimits: buildPlatformMiniflareRateLimits(policy),
      },
    ],
  }),
);

const database = await miniflare.getD1Database("IDENTITY_DB");
const migrations = await readD1Migrations(
  fileURLToPath(new URL("../migrations", import.meta.url)),
);
for (const migration of migrations) {
  if (migration.queries.length > 0) {
    await database.batch(
      migration.queries.map((query) => database.prepare(query)),
    );
  }
}

async function request(worker, pathname, source, query = "") {
  return worker.fetch(`http://platform-native.test${pathname}${query}`, {
    headers: {
      "cf-connecting-ip": source,
      // This header must not become a caller-controlled budget key.
      "x-forwarded-for": `${source}-untrusted`,
    },
  });
}

async function tokenRequest(worker, source, bodyPulls, token) {
  const body = new ReadableStream({
    pull(controller) {
      bodyPulls.count += 1;
      controller.enqueue(new TextEncoder().encode(`grant_type=${token}`));
      controller.close();
    },
  });
  return worker.fetch("http://platform-native.test/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "cf-connecting-ip": source,
      "x-forwarded-for": "198.51.100.250",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    duplex: "half",
  });
}

let workerA;
let workerB;
try {
  workerA = await miniflare.getWorker("platform-native-a");
  workerB = await miniflare.getWorker("platform-native-b");

  const loginOne = await request(workerA, "/login", "203.0.113.10", "?state=a");
  const loginTwo = await request(workerB, "/login", "203.0.113.10", "?state=b");
  const loginThree = await request(
    workerA,
    "/login",
    "203.0.113.10",
    "?state=randomized-and-different",
  );
  assert.equal(loginOne.status, 200, "first login request succeeds");
  assert.equal(
    loginTwo.status,
    200,
    "second login request succeeds on worker B",
  );
  assert.equal(
    loginThree.status,
    429,
    "shared login budget exhausts on worker A",
  );
  assert.equal(loginThree.headers.get("retry-after"), "60");

  const independent = await request(
    workerA,
    "/login",
    "203.0.113.11",
    "?state=independent",
  );
  assert.equal(
    independent.status,
    200,
    "independent source has its own budget",
  );

  const firstBody = { count: 0 };
  const secondBody = { count: 0 };
  const tokenOne = await tokenRequest(workerA, "203.0.113.20", firstBody, "a");
  const tokenTwo = await tokenRequest(workerB, "203.0.113.20", secondBody, "b");
  const exhaustedBody = { count: 0 };
  const tokenThree = await tokenRequest(
    workerA,
    "203.0.113.20",
    exhaustedBody,
    "randomized",
  );
  assert.notEqual(
    tokenOne.status,
    429,
    "first token request reaches the worker",
  );
  assert.notEqual(
    tokenTwo.status,
    429,
    "second token request reaches the worker",
  );
  assert.equal(
    tokenThree.status,
    429,
    "token request is rejected before body work",
  );
  assert.equal(
    tokenThree.headers.get("x-platform-test-body-clones"),
    "0",
    "exhausted request does not enter worker body parsing",
  );
  assert.equal(
    tokenThree.headers.get("x-platform-test-database-prepares"),
    "0",
    "exhausted request does not enter D1/provider work",
  );
  assert.ok(
    Number(tokenOne.headers.get("x-platform-test-body-clones")) > 0,
    "a permitted request enters the worker body parser",
  );
  assert.ok(
    Number(tokenOne.headers.get("x-platform-test-database-prepares")) > 0,
    "a permitted request reaches D1 after body parsing",
  );
  assert.ok(
    firstBody.count > 0,
    "first token request body was read after limiting",
  );
  assert.ok(
    secondBody.count > 0,
    "second token request body was read after limiting",
  );

  console.log(
    JSON.stringify(
      {
        miniflare: "5.20260918.0-alpha",
        workers: ["platform-native-a", "platform-native-b"],
        namespaces: policy,
        proof: {
          sharedSourceAcrossWorkers: [
            loginOne.status,
            loginTwo.status,
            loginThree.status,
          ],
          independentSource: independent.status,
          bodyBeforeExhaustion: [firstBody.count, secondBody.count],
          exhaustedWorkerBodyClones: tokenThree.headers.get(
            "x-platform-test-body-clones",
          ),
          exhaustedDatabasePrepares: tokenThree.headers.get(
            "x-platform-test-database-prepares",
          ),
          tokenStatuses: [tokenOne.status, tokenTwo.status, tokenThree.status],
        },
      },
      null,
      2,
    ),
  );
} finally {
  await miniflare.dispose();
}

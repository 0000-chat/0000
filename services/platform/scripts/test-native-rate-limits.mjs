import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  buildPlatformMiniflareRateLimits,
  validatePlatformRateLimitPolicy,
} from "../src/rate-limit-policy.ts";

const policy = validatePlatformRateLimitPolicy({
  login: { limit: 2, namespace_id: "2026092001" },
  issuance: { limit: 2, namespace_id: "2026092002" },
  management: { limit: 2, namespace_id: "2026092003" },
  verification: { limit: 2, namespace_id: "2026092004" },
  guestControl: { limit: 2, namespace_id: "2026092005" },
});
const rateLimits = buildPlatformMiniflareRateLimits(policy);
const workerScript = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const binding = url.searchParams.get("binding");
    const key = url.searchParams.get("key");
    if (!binding || !key) return new Response("invalid", { status: 400 });
    const result = await env[binding].limit({ key });
    return Response.json({ binding, key, success: result.success });
  },
};`;

const miniflare = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "platform-rate-limit-a",
        compatibilityDate: "2026-09-18",
        modules: true,
        script: workerScript,
        ratelimits: rateLimits,
      },
      {
        name: "platform-rate-limit-b",
        compatibilityDate: "2026-09-18",
        modules: true,
        script: workerScript,
        ratelimits: rateLimits,
      },
    ],
  }),
);

async function request(worker, binding, key) {
  const response = await worker.fetch(
    `http://platform-rate-limit.test/?binding=${encodeURIComponent(binding)}&key=${encodeURIComponent(key)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Native Platform rate-limit probe returned ${response.status}.`,
    );
  }
  return response.json();
}

const result = {};
try {
  const workerA = await miniflare.getWorker("platform-rate-limit-a");
  const workerB = await miniflare.getWorker("platform-rate-limit-b");
  result.sharedNamespaceAndKey = [
    await request(workerA, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-a"),
    await request(workerB, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-a"),
    await request(workerA, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-a"),
  ];
  result.independentSourceKey = [
    await request(workerA, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-b"),
    await request(workerB, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-b"),
    await request(workerA, "PLATFORM_RATE_LIMIT_LOGIN", "login:source-b"),
  ];
  result.independentNamespace = [
    await request(workerA, "PLATFORM_RATE_LIMIT_ISSUANCE", "login:source-a"),
    await request(workerB, "PLATFORM_RATE_LIMIT_ISSUANCE", "login:source-a"),
    await request(workerA, "PLATFORM_RATE_LIMIT_ISSUANCE", "login:source-a"),
  ];
} finally {
  await miniflare.dispose();
}

const assertOutcomes = (name, outcomes) => {
  if (
    outcomes.length !== 3 ||
    outcomes[0].success !== true ||
    outcomes[1].success !== true ||
    outcomes[2].success !== false
  ) {
    throw new Error(`Native Platform rate-limit probe failed for ${name}.`);
  }
};

assertOutcomes("sharedNamespaceAndKey", result.sharedNamespaceAndKey);
assertOutcomes("independentSourceKey", result.independentSourceKey);
assertOutcomes("independentNamespace", result.independentNamespace);

console.log(
  JSON.stringify(
    {
      miniflare: "5.20260918.0-alpha",
      configuration: {
        workers: ["platform-rate-limit-a", "platform-rate-limit-b"],
        period: 60,
        limit: 2,
        bindings: ["PLATFORM_RATE_LIMIT_LOGIN", "PLATFORM_RATE_LIMIT_ISSUANCE"],
      },
      result,
    },
    null,
    2,
  ),
);

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workerEntry = readFileSync(join(import.meta.dir, "worker-entry.ts"), "utf8");
const workerConfig = readFileSync(join(import.meta.dir, "../../wrangler.jsonc"), "utf8");

test("declares and passes all production rate limit bindings at the Worker boundary", () => {
  for (const [option, binding] of [["creation", "MSG_RATE_LIMIT_CREATION"], ["reads", "MSG_RATE_LIMIT_READS"], ["posts", "MSG_RATE_LIMIT_POSTS"], ["live", "MSG_RATE_LIMIT_LIVE"]] as const) {
    expect(workerEntry).toContain(`readonly ${binding}?: MsgRateLimit;`);
    expect(workerEntry).toContain(`${option}: env.${binding}`);
  }
});

test("fails closed for a missing production binding while keeping the unit port optional", () => {
  expect(workerEntry).toContain("const unavailableRateLimit: MsgRateLimit");
  expect(workerEntry).toContain("env.MSG_RATE_LIMIT_CREATION ?? unavailableRateLimit");
  expect(workerEntry).toContain("env.MSG_RATE_LIMIT_READS ?? unavailableRateLimit");
  expect(workerEntry).toContain("env.MSG_RATE_LIMIT_POSTS ?? unavailableRateLimit");
  expect(workerEntry).toContain("env.MSG_RATE_LIMIT_LIVE ?? unavailableRateLimit");
});

test("uses the configured canonical public origin instead of the request origin", () => {
  expect(workerEntry).toContain("readonly MSG_PUBLIC_ORIGIN?: string;");
  expect(workerEntry).toContain("env.MSG_PUBLIC_ORIGIN");
  expect(workerConfig).toContain('"MSG_PUBLIC_ORIGIN": "https://msg.0000.chat"');
});

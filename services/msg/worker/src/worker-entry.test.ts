import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { MsgProductionEnvironment } from "./worker-entry";
import type { MsgRateLimit } from "./worker";
import type { RoomService } from "./protocol";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

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

const actionBindings = {
  creation: "MSG_RATE_LIMIT_CREATION",
  reads: "MSG_RATE_LIMIT_READS",
  posts: "MSG_RATE_LIMIT_POSTS",
  live: "MSG_RATE_LIMIT_LIVE",
} as const;

type RateLimitedAction = keyof typeof actionBindings;

const allowRateLimit: MsgRateLimit = {
  async limit() {
    return { success: true };
  },
};

const failRateLimit: MsgRateLimit = {
  async limit() {
    throw new Error("injected rate-limit failure");
  },
};

function mutationProbe(): { readonly service: RoomService; readonly mutations: () => number } {
  let count = 0;
  const mutate = async (): Promise<never> => {
    count += 1;
    throw new Error("resource mutation reached the service");
  };
  return {
    service: {
      create: mutate,
      read: mutate,
      post: mutate,
      live: mutate,
    },
    mutations: () => count,
  };
}

function requestFor(action: RateLimitedAction): Request {
  const commonHeaders = { accept: "application/json", "cf-connecting-ip": "203.0.113.25" };
  if (action === "creation") {
    return new Request("https://msg.0000.chat/", {
      body: JSON.stringify({ content: "create", author: "probe", display_name: "Probe", semantic_type: "message" }),
      headers: { ...commonHeaders, "content-type": "application/json" },
      method: "POST",
    });
  }
  if (action === "reads") return new Request("https://msg.0000.chat/example", { headers: commonHeaders });
  if (action === "posts") {
    return new Request("https://msg.0000.chat/example", {
      body: JSON.stringify({ content: "post", author: "probe", display_name: "Probe", semantic_type: "message" }),
      headers: { ...commonHeaders, "content-type": "application/json" },
      method: "POST",
    });
  }
  return new Request("https://msg.0000.chat/example/live", { headers: { ...commonHeaders, upgrade: "websocket" } });
}

function productionEnvironment(
  service: RoomService,
  action: RateLimitedAction,
  mode: "missing" | "failed",
): MsgProductionEnvironment {
  const environment: MsgProductionEnvironment = {
    MSG_TEST_MODE: "1",
    ROOM_SERVICE: service,
    MSG_RATE_LIMIT_CREATION: allowRateLimit,
    MSG_RATE_LIMIT_READS: allowRateLimit,
    MSG_RATE_LIMIT_POSTS: allowRateLimit,
    MSG_RATE_LIMIT_LIVE: allowRateLimit,
  };
  const binding = actionBindings[action];
  if (mode === "missing") delete environment[binding];
  else environment[binding] = failRateLimit;
  return environment;
}

test("production entry denies every missing or failed action binding before resource mutation", async () => {
  const { default: productionEntry } = await import("./worker-entry");
  for (const mode of ["missing", "failed"] as const) {
    for (const action of Object.keys(actionBindings) as RateLimitedAction[]) {
      const probe = mutationProbe();
      const response = await productionEntry.fetch(requestFor(action), productionEnvironment(probe.service, action, mode));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: { code: "rate_limited", message: "Too many requests. Retry later." } });
      expect(probe.mutations()).toBe(0);
    }
  }
});

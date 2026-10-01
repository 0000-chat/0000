import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

import { expect, test } from "bun:test";

import { parseMsgRateLimitPolicyJson } from "../../scripts/msg-rate-limit-policy";
import { createMsgMiniflareTempDirectory, startMsgMiniflare, TEST_ROOM_LIMITS } from "../test-fixtures/msg-worker.miniflare-fixture";

async function createRoom(fixture: Awaited<ReturnType<typeof startMsgMiniflare>>, actor: string): Promise<number> {
  const response = await fixture.miniflare.dispatchFetch("https://msg.0000.chat/", {
    method: "POST",
    headers: {
      accept: "application/json",
      "cf-connecting-ip": actor,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "quota probe", author: "probe", display_name: "Probe", semantic_type: "message" }),
  });
  return response.status;
}

test.serial("uses the managed and self-host policy examples as real binding thresholds", { timeout: 30_000 }, async () => {
  for (const [name, expectedSuccessfulCreations] of [["managed", 6], ["self-host", 12]] as const) {
    const policy = parseMsgRateLimitPolicyJson(readFileSync(new URL(`../../docs/examples/msg-rate-limit-policy.${name}.json`, import.meta.url), "utf8"));
    const persistenceDirectory = await createMsgMiniflareTempDirectory(`t13-${name}-quota`);
    let fixture: Awaited<ReturnType<typeof startMsgMiniflare>> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      fixture = await startMsgMiniflare(persistenceDirectory, TEST_ROOM_LIMITS, {}, true, false, policy);
      const statuses: number[] = [];
      for (let index = 0; index <= expectedSuccessfulCreations; index += 1) {
        statuses.push(await createRoom(fixture, "203.0.113.25"));
      }
      expect(statuses.slice(0, expectedSuccessfulCreations).every((status) => status === 201)).toBe(true);
      expect(statuses[expectedSuccessfulCreations]).toBe(429);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        await fixture?.dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      await rm(persistenceDirectory, { force: true, recursive: true });
    }
    if (failed) throw failure;
  }
});

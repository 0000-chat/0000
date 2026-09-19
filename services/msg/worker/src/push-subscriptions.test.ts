import { expect, test } from "bun:test";

import { parsePushBrowserId, parsePushSubscription } from "./push-subscriptions";

const nativeSubscription = {
  endpoint: "https://push.example.net/push/subscription-token",
  keys: {
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  },
};

test("accepts native PushSubscription JSON with an optional expirationTime", async () => {
  for (const expirationTime of [undefined, null, 1_800_000_000_000]) {
    const parsed = await parsePushSubscription({ ...nativeSubscription, ...(expirationTime === undefined ? {} : { expirationTime }) });
    expect(parsed).toEqual({
      auth: nativeSubscription.keys.auth,
      endpoint: nativeSubscription.endpoint,
      p256dh: nativeSubscription.keys.p256dh,
    });
  }
});

test("rejects invalid native expiration times and unexpected subscription fields", async () => {
  for (const expirationTime of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "never"]) {
    expect(await parsePushSubscription({ ...nativeSubscription, expirationTime })).toBeUndefined();
  }
  expect(await parsePushSubscription({ ...nativeSubscription, applicationServerKey: "unexpected" })).toBeUndefined();
  expect(await parsePushSubscription({ ...nativeSubscription, keys: { ...nativeSubscription.keys, extra: "unexpected" } })).toBeUndefined();
});

test("validates and normalizes origin-local UUID browser identities", () => {
  const uppercase = "123E4567-E89B-42D3-A456-426614174000";
  expect(parsePushBrowserId(uppercase)).toBe(uppercase.toLowerCase());
  expect(parsePushBrowserId(null)).toBeUndefined();
  expect(parsePushBrowserId("not-a-uuid")).toBeUndefined();
  expect(parsePushBrowserId("123e4567-e89b-02d3-a456-426614174000")).toBeUndefined();
});

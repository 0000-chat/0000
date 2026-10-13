import { expect, test } from "bun:test";

import { decryptWebhookRecord, encryptWebhookRecord, isWebhookEnvelope } from "./webhook-crypto";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("encrypts header records with endpoint-scoped authenticated context", async () => {
  const value = { Authorization: "synthetic-header-value-crypto-1" };
  const first = await encryptWebhookRecord(key, "room-1", "endpoint-1", "headers", value);
  const second = await encryptWebhookRecord(key, "room-1", "endpoint-2", "headers", value);

  expect(isWebhookEnvelope(first)).toBe(true);
  expect(isWebhookEnvelope(second)).toBe(true);
  expect(first).not.toContain("synthetic-header-value-crypto-1");
  expect(second).not.toContain("synthetic-header-value-crypto-1");
  expect(first).not.toBe(second);
  await expect(decryptWebhookRecord<typeof value>(key, "room-1", "endpoint-1", "headers", first)).resolves.toEqual(value);
  await expect(decryptWebhookRecord<typeof value>(key, "room-1", "endpoint-2", "headers", first)).rejects.toThrow();
});

test("rejects missing and malformed encryption keys", async () => {
  await expect(encryptWebhookRecord("", "room-1", "endpoint-1", "headers", { Authorization: "synthetic" })).rejects.toThrow();
  await expect(encryptWebhookRecord("invalid", "room-1", "endpoint-1", "headers", { Authorization: "synthetic" })).rejects.toThrow();
});

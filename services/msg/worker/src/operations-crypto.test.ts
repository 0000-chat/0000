import { expect, test } from "bun:test";

import { decryptOperationRecord, encryptOperationRecord } from "./operations-crypto";

const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

test("encrypts operation records with a versioned AES-GCM envelope", async () => {
  const envelope = await encryptOperationRecord(key, "abuse_report", "report-1", { description: "unsafe content" });

  expect(JSON.parse(envelope)).toMatchObject({ v: 1, iv: expect.any(String), ciphertext: expect.any(String) });
  await expect(decryptOperationRecord(key, "abuse_report", "report-1", envelope)).resolves.toEqual({ description: "unsafe content" });
});

test("rejects an operation record when its domain-separated AAD does not match", async () => {
  const envelope = await encryptOperationRecord(key, "creation_idempotency", "key-1", { room: "secret-capability" });

  await expect(decryptOperationRecord(key, "creation_idempotency", "key-2", envelope)).rejects.toThrow();
});

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

import { acquireMiniflareTestLock } from "../test-fixtures/miniflare-test-lock";
import { D1OperationStore, type D1DatabaseLike } from "./operations";
import { buildShareMessage, type CreateRoomResponse } from "./protocol";

const key = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const created = {
  conversation_url: "https://msg.0000.chat/room-capability",
  protocol_version: 1 as const,
  room: { created_at: "2026-08-10T00:00:00.000Z", expires_at: "2026-08-17T00:00:00.000Z", id: "room-capability", protocol_version: 1 as const },
  share_message: buildShareMessage("https://msg.0000.chat/room-capability"),
  wait: {
    after: 1,
    command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/room-capability' --after 1",
    requires_user_consent: true,
  },
} satisfies CreateRoomResponse;

const fixtures: Array<{ fixture: Miniflare; releaseRuntime: () => Promise<void> }> = [];

afterEach(async () => {
  for (const { fixture, releaseRuntime } of fixtures.splice(0)) {
    try {
      await fixture.dispose();
    } finally {
      await releaseRuntime();
    }
  }
});

async function store(clock: { now: number }, migrations = ["0001_operations.sql", "0002_operations_retention.sql", "0003_creation_plan.sql"]) {
  const releaseRuntime = await acquireMiniflareTestLock();
  const fixture = new Miniflare({
    compatibilityDate: "2026-05-15",
    d1Databases: { OPS: "operations-test" },
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
  });
  try {
    await fixture.ready;
    const d1 = await fixture.getD1Database("OPS");
    for (const migration of migrations) {
      const source = await readFile(fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url)), "utf8");
      for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) await d1.prepare(statement).run();
    }
    fixtures.push({ fixture, releaseRuntime });
    return { d1, operations: new D1OperationStore(d1 as unknown as D1DatabaseLike, key, () => clock.now) };
  } catch (error) {
    try {
      await fixture.dispose();
    } finally {
      await releaseRuntime();
    }
    throw error;
  }
}

test("atomically claims, completes, and replays an encrypted creation receipt", { timeout: 20_000 }, async () => {
  const clock = { now: 1_000 };
  const { operations } = await store(clock);
  const claim = await operations.claimCreation("create-key", "fingerprint");

  expect(claim.kind).toBe("claimed");
  if (claim.kind !== "claimed") throw new Error("Expected a lease.");
  await operations.completeCreation("create-key", claim.leaseToken, created);

  await expect(operations.claimCreation("create-key", "fingerprint")).resolves.toEqual({ kind: "complete", response: created });
  await expect(operations.claimCreation("create-key", "different")).resolves.toEqual({ kind: "conflict" });
});

test("returns in-progress for a current lease and fences stale claimants", { timeout: 20_000 }, async () => {
  const clock = { now: 1_000 };
  const { operations } = await store(clock);
  const first = await operations.claimCreation("create-key", "fingerprint");
  if (first.kind !== "claimed") throw new Error("Expected first lease.");

  await expect(operations.claimCreation("create-key", "fingerprint")).resolves.toEqual({ kind: "pending" });
  clock.now += 60_001;
  const second = await operations.claimCreation("create-key", "fingerprint");
  expect(second.kind).toBe("claimed");
  if (second.kind !== "claimed") throw new Error("Expected stale replacement lease.");
  await expect(operations.completeCreation("create-key", first.leaseToken, created)).rejects.toThrow("lease");
  await expect(operations.completeCreation("create-key", second.leaseToken, created)).resolves.toBeUndefined();
});

test("permits only one concurrent same-key claimant", { timeout: 20_000 }, async () => {
  const { operations } = await store({ now: 1_000 });
  const claims = await Promise.all(Array.from({ length: 8 }, () => operations.claimCreation("create-key", "fingerprint")));

  expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
  expect(claims.filter((claim) => claim.kind === "pending")).toHaveLength(7);
});

test("opportunistically removes expired encrypted receipts, reports, and audit rows", { timeout: 20_000 }, async () => {
  const clock = { now: 1_000 };
  const { d1, operations } = await store(clock);
  const claim = await operations.claimCreation("create-key", "fingerprint");
  if (claim.kind !== "claimed") throw new Error("Expected creation lease.");
  await operations.completeCreation("create-key", claim.leaseToken, created);
  await operations.submitReport({ capability: "room-capability", description: "review" });
  await operations.audit("forced_delete", "room-capability", "complete");

  clock.now += 90 * 24 * 60 * 60 * 1000 + 1;
  await operations.listReports(10);

  await expect(d1.prepare("SELECT COUNT(*) AS count FROM creation_idempotency").first<{ count: number }>()).resolves.toEqual({ count: 0 });
  await expect(d1.prepare("SELECT COUNT(*) AS count FROM abuse_reports").first<{ count: number }>()).resolves.toEqual({ count: 0 });
  await expect(d1.prepare("SELECT COUNT(*) AS count FROM operator_audit").first<{ count: number }>()).resolves.toEqual({ count: 0 });
});

test("stores report details encrypted and exposes them only through operator reads", { timeout: 20_000 }, async () => {
  const { d1, operations } = await store({ now: 1_000 });
  await operations.submitReport({ capability: "room-capability", description: "review text" });

  const listed = await operations.listReports(1);
  const raw = await d1.prepare("SELECT report_envelope FROM abuse_reports WHERE id = ?").bind(listed[0].id).first<{ report_envelope: string }>();
  const read = await operations.readReport(listed[0].id);
  const updated = await operations.updateReportStatus(listed[0].id, "reviewed");

  expect(raw?.report_envelope).not.toContain("room-capability");
  expect(raw?.report_envelope).not.toContain("review text");
  expect(read).toMatchObject({ capability: "room-capability", description: "review text", status: "open" });
  expect(updated).toMatchObject({ status: "reviewed" });
});

test("stores opaque keyed creation identifiers and fingerprints", { timeout: 20_000 }, async () => {
  const { d1, operations } = await store({ now: 1_000 });
  const rawKey = "raw-idempotency-key";
  const rawFingerprint = "raw-request-fingerprint";
  await operations.claimCreation(rawKey, rawFingerprint);
  const row = await d1.prepare("SELECT idempotency_key, request_fingerprint, plan_envelope FROM creation_idempotency").first<{ idempotency_key: string; request_fingerprint: string; plan_envelope: string }>();
  expect(row?.idempotency_key).not.toContain(rawKey);
  expect(row?.request_fingerprint).not.toContain(rawFingerprint);
  expect(row?.plan_envelope).not.toContain("management");
});

test("does not recover an unscoped pre-plan receipt", { timeout: 20_000 }, async () => {
  const { d1, operations } = await store({ now: 1_000 });
  const { wait: _wait, ...legacyCreated } = created;
  const envelope = await (await import("./operations-crypto")).encryptOperationRecord(key, "creation_idempotency", "legacy-key", legacyCreated);
  await d1.prepare("INSERT INTO creation_idempotency (idempotency_key, request_fingerprint, state, response_envelope, plan_envelope, lease_token, created_at, updated_at, expires_at) VALUES (?, ?, 'complete', ?, '', '', ?, ?, ?)").bind("legacy-key", "legacy-fingerprint", envelope, 1, 1, 86_400_001).run();
  const claim = await operations.claimCreation("legacy-key", "legacy-fingerprint", "guest-a");
  expect(claim.kind).toBe("claimed");
  expect(claim.kind === "complete" ? claim.response : undefined).not.toEqual(legacyCreated);
});

test("does not hold an unscoped pre-plan pending row", { timeout: 20_000 }, async () => {
  const { d1, operations } = await store({ now: 1_000 });
  await d1.prepare("INSERT INTO creation_idempotency (idempotency_key, request_fingerprint, state, response_envelope, plan_envelope, lease_token, created_at, updated_at, expires_at) VALUES (?, ?, 'pending', NULL, '', 'legacy', ?, ?, ?)").bind("legacy-key", "legacy-fingerprint", 1, 1, 86_400_001).run();
  const claim = await operations.claimCreation("legacy-key", "legacy-fingerprint", "guest-a");
  expect(claim.kind).toBe("claimed");
});

test("scopes creation plans and receipts by stable guest control", { timeout: 20_000 }, async () => {
  const { operations } = await store({ now: 1_000 });
  const first = await operations.claimCreation("same-key", "fingerprint", "guest-a");
  if (first.kind !== "claimed") throw new Error("Expected the first guest to claim the plan.");
  await operations.completeCreation("same-key", first.leaseToken, created, "guest-a");
  await expect(operations.claimCreation("same-key", "fingerprint", "guest-a")).resolves.toEqual({ kind: "complete", response: created });
  const second = await operations.claimCreation("same-key", "fingerprint", "guest-b");
  expect(second.kind).toBe("claimed");
  if (second.kind === "claimed") expect(second.plan.room).not.toBe(first.plan.room);
});

test("persists the owner grant reference for an idempotent retry", { timeout: 20_000 }, async () => {
  const { operations } = await store({ now: 1_000 });
  const first = await operations.claimCreation("same-key", "fingerprint", "guest-a");
  if (first.kind !== "claimed") throw new Error("Expected the first guest to claim the plan.");
  await operations.completeCreation("same-key", first.leaseToken, created, "guest-a", "owner-grant-a");
  await expect(operations.claimCreation("same-key", "fingerprint", "guest-a")).resolves.toEqual({ kind: "complete", response: created, ownerGrantId: "owner-grant-a" });
});

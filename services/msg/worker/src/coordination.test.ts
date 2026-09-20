import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

import { hashCapability } from "./room-domain";
import { DurableRoomService } from "./room-service";
import { createWorker } from "./worker";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) { this.ctx = ctx; }
  },
}));

class Context {
  readonly storage: { readonly sql: { exec(query: string, ...values: unknown[]): Iterable<unknown> }; transactionSync<T>(callback: () => T): T; setAlarm(value: number): Promise<void>; deleteAlarm(): Promise<void> };
  constructor(readonly database: Database) {
    this.storage = {
      sql: { exec: (query, ...values) => {
        if (values.length === 0 && query.includes(";")) { database.exec(query); return []; }
        const statement = database.query(query);
        if (/^\s*(?:SELECT|PRAGMA)/iu.test(query)) return statement.all(...(values as never[]));
        statement.run(...(values as never[])); return [];
      } },
      transactionSync: <T>(callback: () => T) => database.transaction(callback)(),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    };
  }
  getWebSockets() { return []; }
  waitUntil() {}
}

async function room() {
  const { ConversationRoom } = await import("./conversation-room");
  const database = new Database(":memory:");
  let now = 10_000;
  const context = new Context(database);
  return { context, database, room: new ConversationRoom(context as never, { MSG_TEST_MODE: "1", MSG_TEST_ROOM_LIMITS: "{}" }, () => now), setNow: (value: number) => { now = value; } };
}

function json(path: string, value: unknown, method = "POST"): Request {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") init.body = JSON.stringify(value);
  return new Request(`https://room${path}`, init);
}

function proposal(retry: string, source: string, baseRevision = 0, title = "Collect evidence") {
  return {
    actor_label: "participant-a",
    base_revision: baseRevision,
    body: {
      completion_criteria: ["A checked report is linked"],
      decision_impact: "Informs the next release decision.",
      owner_label: "owner-a",
      purpose: "Collect evidence for the release.",
      requested_output: "A short checked report.",
      title,
      unknowns: ["Which source is current?"],
    },
    client_retry_id: retry,
    kind: "request.create",
    source_message_ids: [source],
  };
}

function progress(retry: string, requestId: string, status: string, baseRevision: number, source: string, extra: Record<string, unknown> = {}) {
  return {
    actor_label: "reporter-a",
    base_revision: baseRevision,
    body: {
      blockers: status === "blocked" ? ["Waiting for source owner"] : [],
      evidence: status === "done" ? [{ artifact_url: "https://example.com/report", location: "tab:Summary!A1", reported_verification: "Reported checked against the cited source.", remaining_blockers: [] }] : [],
      request_id: requestId,
      status,
      ...extra,
    },
    client_retry_id: retry,
    kind: "request.progress",
    source_message_ids: [source],
  };
}

function panelProposal(retry: string, source: string, baseRevision = 0, purpose: string | null = "Ship the room panel") {
  return {
    actor_label: "panel-author",
    base_revision: baseRevision,
    body: {
      artifacts: [{ role: "canonical spec", title: "Room spec", url: "https://example.com/spec" }],
      next_actions: [{ description: "Review the panel", owner_label: "room-owner" }],
      phase: "review",
      purpose,
    },
    client_retry_id: retry,
    kind: "panel.replace",
    source_message_ids: [source],
  };
}

test("routes a complete panel replacement through pending review, exact publication, history, and agent reads", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "panel source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);
  const initialLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json" } }));
  const initialLegacyEtag = initialLegacyRead.headers.get("etag");
  const initialLegacyValue = await initialLegacyRead.json() as { latest_message: number; expires_at: string };
  const initialBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json" } }));
  const initialBoundedEtag = initialBoundedRead.headers.get("etag");
  const initialBoundedValue = await initialBoundedRead.json() as { latest_message: number; expires_at: string };
  expect(initialLegacyEtag).not.toBe(initialBoundedEtag);
  const initialOverview = await worker.fetch(new Request("https://msg.0000.chat/room/coordination"));
  const initialEtag = initialOverview.headers.get("etag");
  const proposalResponse = await durable.fetch(json("/coordination/proposals", panelProposal("panel-proposal", sourceId)));
  expect(proposalResponse.status).toBe(201);
  const proposalValue = await proposalResponse.json() as { proposal: { proposal_id: string; request_id: string | null; revision: number } };
  expect(proposalValue.proposal.request_id).toBeNull();
  expect((await (await durable.fetch(new Request("https://room/coordination"))).json()) as { pending_panel_proposal_count: number; panel: unknown }).toMatchObject({ pending_panel_proposal_count: 1, panel: null });
  const pendingOverview = await worker.fetch(new Request("https://msg.0000.chat/room/coordination", { headers: { "if-none-match": initialEtag ?? "" } }));
  expect(pendingOverview.status).toBe(200);
  expect(pendingOverview.headers.get("etag")).not.toBe(initialEtag);
  const pendingLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", "if-none-match": initialLegacyEtag ?? "" } }));
  expect(pendingLegacyRead.status).toBe(200);
  expect(await pendingLegacyRead.json()).toMatchObject({ latest_message: initialLegacyValue.latest_message, expires_at: initialLegacyValue.expires_at });
  const pendingBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json", "if-none-match": initialBoundedEtag ?? "" } }));
  expect(pendingBoundedRead.status).toBe(200);
  expect(await pendingBoundedRead.json()).toMatchObject({ latest_message: initialBoundedValue.latest_message, expires_at: initialBoundedValue.expires_at });
  const published = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "panel-publish", owner_label: "room-owner", proposal_id: proposalValue.proposal.proposal_id, revision: 1 }));
  expect(published.status).toBe(201);
  const publication = await published.json() as { panel: { purpose: string | null; artifacts: readonly { role: string }[]; next_actions: readonly { owner_label: string }[]; published_revision: number }; request?: unknown; published_revision: number };
  expect(publication.request).toBeUndefined();
  expect(publication).toMatchObject({ published_revision: 1, panel: { purpose: "Ship the room panel", artifacts: [{ role: "canonical spec" }], next_actions: [{ owner_label: "room-owner" }], published_revision: 1 } });
  const afterPublication = await worker.fetch(new Request("https://msg.0000.chat/room/coordination", { headers: { "if-none-match": pendingOverview.headers.get("etag") ?? "" } }));
  expect(afterPublication.status).toBe(200);
  const afterPublicationLegacyRead = await worker.fetch(new Request("https://msg.0000.chat/room", { headers: { accept: "application/json", "if-none-match": pendingLegacyRead.headers.get("etag") ?? "" } }));
  expect(afterPublicationLegacyRead.status).toBe(200);
  expect(await afterPublicationLegacyRead.json()).toMatchObject({ latest_message: initialLegacyValue.latest_message, expires_at: initialLegacyValue.expires_at });
  const afterPublicationBoundedRead = await worker.fetch(new Request("https://msg.0000.chat/room?limit=20", { headers: { accept: "application/json", "if-none-match": pendingBoundedRead.headers.get("etag") ?? "" } }));
  expect(afterPublicationBoundedRead.status).toBe(200);
  expect(await afterPublicationBoundedRead.json()).toMatchObject({ latest_message: initialBoundedValue.latest_message, expires_at: initialBoundedValue.expires_at });
  const panel = await (await durable.fetch(new Request("https://room/coordination/panel"))).json() as { panel: { proposal_id: string; published_revision: number } | null };
  expect(panel).toMatchObject({ panel: { proposal_id: proposalValue.proposal.proposal_id, published_revision: 1 } });
  expect((await durable.fetch(new Request("https://room/coordination/panel?revision=1"))).status).toBe(200);
  expect((await durable.fetch(new Request("https://room/coordination/panel?revision=9"))).status).toBe(404);
  const history = await (await durable.fetch(new Request("https://room/coordination/panel/history?limit=20"))).json() as { events: readonly { cursor: number; panel?: unknown }[] };
  expect(history.events).toHaveLength(1);
  const read = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { coordination_overview: { panel_published_revision: number } };
  expect(read.coordination_overview.panel_published_revision).toBe(1);
});

test("runs proposal, review, exact publication, retries, and revisions inside the room route", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source evidence", author: "participant", display_name: "Participant", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const before = await durable.fetch(new Request("https://room/read?after=0&limit=20"));
  const beforeValue = await before.json() as { expires_at: string; latest_message: number; coordination_cursor: number };

  const created = await durable.fetch(json("/coordination/proposals", proposal("proposal-1", sourceId)));
  expect(created.status).toBe(201);
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number; status: string; source_messages: readonly { id: string; content?: string }[] }; coordination_cursor: number; replayed: boolean };
  expect(createdValue).toMatchObject({ coordination_cursor: 1, replayed: false, proposal: { revision: 1, status: "pending", source_messages: [{ id: sourceId }] } });
  expect(createdValue.proposal.source_messages[0]).not.toHaveProperty("content");

  const overview = await durable.fetch(new Request("https://room/coordination"));
  expect(await overview.json()).toMatchObject({ empty: false, pending_proposal_count: 1, published_request_count: 0, published_revision: 0 });
  const list = await durable.fetch(new Request("https://room/coordination/proposals?limit=20"));
  expect(await list.json()).toMatchObject({ has_more: false, next_after: 1, through: 1, proposals: [{ proposal_id: createdValue.proposal.proposal_id }] });

  const replay = await durable.fetch(json("/coordination/proposals", proposal("proposal-1", sourceId)));
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ replayed: true, coordination_cursor: 1, proposal: { proposal_id: createdValue.proposal.proposal_id } });
  const changed = await durable.fetch(json("/coordination/proposals", { ...proposal("proposal-1", sourceId), body: { ...proposal("proposal-1", sourceId).body, title: "Changed" } }));
  expect(changed.status).toBe(409);

  const wrongOwner = await durable.fetch(json("/coordination/publish?token=owner-token-wrong", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(wrongOwner.status).toBe(404);
  const published = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(published.status).toBe(201);
  expect(await published.json()).toMatchObject({ published_revision: 1, replayed: false, request: { request_id: createdValue.proposal.request_id, status: "open" }, proposal: { status: "published" } });
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof beforeValue;
  expect(after).toMatchObject({ latest_message: beforeValue.latest_message, coordination_cursor: 2, expires_at: beforeValue.expires_at });

  const publishReplay = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(publishReplay.status).toBe(200);
  expect(await publishReplay.json()).toMatchObject({ replayed: true, published_revision: 1 });
  const rejectedReplay = await durable.fetch(json("/coordination/publish?token=owner-token-wrong", { base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }));
  expect(rejectedReplay.status).toBe(404);

});

test("routes public proposal and private publication through Worker, service, and the room", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const proposalResponse = await worker.fetch(json("/room/coordination/proposals", proposal("worker-proposal", sourceId)));
  expect(proposalResponse.status).toBe(201);
  const proposalValue = await proposalResponse.json() as { proposal: { proposal_id: string; revision: number }; proposal?: { source_messages?: readonly { content?: string }[] } };
  expect(proposalValue.proposal?.source_messages?.[0]).not.toHaveProperty("content");
  const publicationResponse = await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "worker-publication", owner_label: "owner", proposal_id: proposalValue.proposal.proposal_id, revision: proposalValue.proposal.revision }));
  expect(publicationResponse.status).toBe(201);
  expect(await publicationResponse.json()).toMatchObject({ request: { status: "open" }, proposal: { status: "published" } });
});

test("routes progress publication and filters through Worker without changing chat state", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const service = new DurableRoomService({ getByName: () => ({ fetch: (request: Request) => durable.fetch(request) }) }, "https://msg.0000.chat");
  const worker = createWorker(service);

  const created = await worker.fetch(json("/room/coordination/proposals", proposal("worker-progress-create", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number } };
  expect((await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 0, client_retry_id: "worker-progress-create-publish", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: createdValue.proposal.revision })))).toHaveProperty("status", 201);
  const before = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as { latest_message: number; expires_at: string };

  const report = await worker.fetch(json("/room/coordination/proposals", progress("worker-progress-report", createdValue.proposal.request_id, "in_progress", 1, sourceId)));
  expect(report.status).toBe(201);
  const reportValue = await report.json() as { proposal: { proposal_id: string; revision: number; status: string } };
  expect(reportValue.proposal).toMatchObject({ revision: 1, status: "pending" });
  const pendingFilter = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/requests?owner_label=owner-a&status=in_progress&limit=20"));
  expect(await pendingFilter.json()).toMatchObject({ requests: [], owner_label: "owner-a", status: "in_progress" });

  const published = await worker.fetch(json("/manage/room/owner-token/coordination/publish", { base_revision: 1, client_retry_id: "worker-progress-publish", owner_label: "owner", proposal_id: reportValue.proposal.proposal_id, revision: reportValue.proposal.revision }));
  expect(published.status).toBe(201);
  expect(await published.json()).toMatchObject({ request: { request_id: createdValue.proposal.request_id, body: { owner_label: "owner-a" }, status: "in_progress", progress: { reported_by: "reporter-a", authority_class: "management" } }, proposal: { status: "published" } });
  const filtered = await worker.fetch(new Request("https://msg.0000.chat/room/coordination/requests?owner_label=owner-a&status=in_progress&limit=20"));
  expect(await filtered.json()).toMatchObject({ requests: [{ request_id: createdValue.proposal.request_id, status: "in_progress" }], owner_label: "owner-a", status: "in_progress" });
  const after = await (await durable.fetch(new Request("https://room/read?after=0&limit=20"))).json() as typeof before;
  expect(after).toMatchObject({ latest_message: before.latest_message, expires_at: before.expires_at });
});

test("rejects foreign sources and reports stale publication without consuming retry IDs", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const missing = await durable.fetch(json("/coordination/proposals", proposal("missing", "foreign-source")));
  expect(missing.status).toBe(404);
  const first = await durable.fetch(json("/coordination/proposals", proposal("one", sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string } };
  const second = await durable.fetch(json("/coordination/proposals", proposal("two", sourceId)));
  const secondValue = await second.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-one", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const stale = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-two", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 1, submitted_base_revision: 0 } });
  const rebased = await durable.fetch(json(`/coordination/proposals/${secondValue.proposal.proposal_id}/revisions`, proposal("two-rebased", sourceId, 1, "Rebased")));
  expect(rebased.status).toBe(201);
  const rebasedValue = await rebased.json() as { proposal: { revision: number } };
  const staleRevision = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-old", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }));
  expect(staleRevision.status).toBe(409);
  const publishRebased = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-rebased", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: rebasedValue.proposal.revision }));
  expect(publishRebased.status).toBe(201);
});

test("freezes proposal revision and status at the requested coordination cursor", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const first = await durable.fetch(json("/coordination/proposals", proposal("first", sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string; revision: number } };
  const revised = await durable.fetch(json(`/coordination/proposals/${firstValue.proposal.proposal_id}/revisions`, proposal("second", sourceId, 0, "Revised")));
  expect(revised.status).toBe(201);
  const revisedValue = await revised.json() as { proposal: { revision: number } };

  const live = await durable.fetch(new Request("https://room/coordination/proposals?limit=20"));
  expect(await live.json()).toMatchObject({ through: 2, proposals: [{ revision: revisedValue.proposal.revision, status: "pending" }] });
  const frozen = await durable.fetch(new Request("https://room/coordination/proposals?limit=20&through=1"));
  expect(await frozen.json()).toMatchObject({ through: 1, proposals: [{ revision: firstValue.proposal.revision, status: "pending" }] });

  const oldDetail = await durable.fetch(new Request(`https://room/coordination/proposals/${firstValue.proposal.proposal_id}/revisions/1`));
  expect(await oldDetail.json()).toMatchObject({ proposal: { revision: 1, status: "superseded" } });
  const oldPublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-old", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }));
  expect(oldPublication.status).toBe(409);
  const publication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-new", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: revisedValue.proposal.revision }));
  expect(publication.status).toBe(201);
});

test("keeps reported progress pending, publishes evidence, filters canonical status, and pages event history", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("create-progress", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-create-progress", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const report = await durable.fetch(json("/coordination/proposals", progress("report-done", createdValue.proposal.request_id, "done", 1, sourceId)));
  expect(report.status).toBe(201);
  const reportValue = await report.json() as { proposal: { proposal_id: string; revision: number; status: string; body: Record<string, unknown> } };
  expect(reportValue.proposal).toMatchObject({ revision: 1, status: "pending", body: { request_id: createdValue.proposal.request_id, status: "done" } });
  expect(await (await durable.fetch(new Request("https://room/coordination"))).json()).toMatchObject({ pending_proposal_count: 1, published_request_count: 1 });
  expect((await durable.fetch(new Request("https://room/coordination/requests?status=done&limit=20"))).json()).resolves.toMatchObject({ requests: [] });

  const publication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-done", owner_label: "owner", proposal_id: reportValue.proposal.proposal_id, revision: 1 }));
  expect(publication.status).toBe(201);
  const publicationValue = await publication.json() as { request: { status: string; evidence: readonly { artifact_url: string; reported_by: string }[]; progress?: { reported_by: string; authority_class: string } } };
  expect(publicationValue.request).toMatchObject({ status: "done", evidence: [{ artifact_url: "https://example.com/report", reported_by: "reporter-a" }], progress: { reported_by: "reporter-a", authority_class: "management" } });
  const filtered = await durable.fetch(new Request("https://room/coordination/requests?owner_label=owner-a&status=done&limit=20"));
  expect(await filtered.json()).toMatchObject({ requests: [{ request_id: createdValue.proposal.request_id, status: "done" }], status: "done", owner_label: "owner-a" });

  const blockedReport = await durable.fetch(json("/coordination/proposals", progress("report-blocked", createdValue.proposal.request_id, "blocked", 2, sourceId, { reopen_reason: "A remaining blocker needs owner attention." })));
  const blockedValue = await blockedReport.json() as { proposal: { proposal_id: string; revision: number } };
  const blockedPublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-blocked", owner_label: "owner", proposal_id: blockedValue.proposal.proposal_id, revision: 1 }));
  expect(blockedPublication.status).toBe(201);
  const detail = await durable.fetch(new Request(`https://room/coordination/requests/${createdValue.proposal.request_id}?after=0&through=6&limit=20`));
  expect(await detail.json()).toMatchObject({ history_after: 0, revisions: [{ kind: "request.create" }, { kind: "request.progress" }, { kind: "request.progress" }] });
});

test("keeps a captured request page stable when a later report updates an undelivered row", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const first = await durable.fetch(json("/coordination/proposals", proposal("page-first", sourceId, 0, "First request")));
  const firstValue = await first.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "page-first-publish", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const second = await durable.fetch(json("/coordination/proposals", proposal("page-second", sourceId, 1, "Second request")));
  const secondValue = await second.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "page-second-publish", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const pageOne = await durable.fetch(new Request("https://room/coordination/requests?owner_label=owner-a&status=open&limit=1"));
  const pageOneValue = await pageOne.json() as { through: number; next_after: number; has_more: boolean; requests: readonly { request_id: string; status: string }[] };
  expect(pageOneValue).toMatchObject({ through: 2, next_after: 1, has_more: true, requests: [{ request_id: firstValue.proposal.request_id, status: "open" }] });

  const competing = await durable.fetch(json("/coordination/proposals", progress("page-second-blocked", secondValue.proposal.request_id, "blocked", 2, sourceId)));
  const competingValue = await competing.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "page-second-blocked-publish", owner_label: "owner", proposal_id: competingValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);

  const pageTwo = await durable.fetch(new Request(`https://room/coordination/requests?owner_label=owner-a&status=open&after=${pageOneValue.next_after}&through=${pageOneValue.through}&limit=1`));
  const pageTwoValue = await pageTwo.json() as { requests: readonly { request_id: string; status: string }[]; has_more: boolean; next_after: number; through: number };
  expect(pageTwoValue).toMatchObject({ through: 2, has_more: false, next_after: 2, requests: [{ request_id: secondValue.proposal.request_id, status: "open" }] });
  expect(pageTwoValue.requests.filter((request) => request.request_id === secondValue.proposal.request_id)).toHaveLength(1);
});

test("rejects done reports without evidence and requires a reason to reopen", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("create-reopen", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "publish-reopen-create", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const invalid = await durable.fetch(json("/coordination/proposals", { ...progress("invalid-done", createdValue.proposal.request_id, "done", 1, sourceId), body: { blockers: [], evidence: [], request_id: createdValue.proposal.request_id, status: "done" } }));
  expect(invalid.status).toBe(400);
  const done = await durable.fetch(json("/coordination/proposals", progress("done-for-reopen", createdValue.proposal.request_id, "done", 1, sourceId, { evidence: [], unverified_explanation: "Reported complete; external artifact was not independently verified." })));
  const doneValue = await done.json() as { proposal: { proposal_id: string } };
  const donePublication = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "publish-done-reopen", owner_label: "owner", proposal_id: doneValue.proposal.proposal_id, revision: 1 }));
  expect(donePublication.status).toBe(201);
  expect(await donePublication.json()).toMatchObject({ request: { status: "done", evidence: [], progress: { unverified_explanation: "Reported complete; external artifact was not independently verified." } } });
  const reopen = await durable.fetch(json("/coordination/proposals", progress("reopen-missing", createdValue.proposal.request_id, "open", 2, sourceId)));
  const reopenValue = await reopen.json() as { proposal: { proposal_id: string } };
  const missingReason = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-reopen-missing", owner_label: "owner", proposal_id: reopenValue.proposal.proposal_id, revision: 1 }));
  expect(missingReason.status).toBe(409);
  const revised = await durable.fetch(json(`/coordination/proposals/${reopenValue.proposal.proposal_id}/revisions`, progress("reopen-with-reason", createdValue.proposal.request_id, "open", 2, sourceId, { reopen_reason: "New source evidence requires follow-up." })));
  const revisedValue = await revised.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "publish-reopen-with-reason", owner_label: "owner", proposal_id: revisedValue.proposal.proposal_id, revision: revisedValue.proposal.revision }))).status).toBe(201);

  const withdrawn = await durable.fetch(json("/coordination/proposals", progress("withdraw-after-reopen", createdValue.proposal.request_id, "withdrawn", 3, sourceId)));
  const withdrawnValue = await withdrawn.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 3, client_retry_id: "publish-withdrawn", owner_label: "owner", proposal_id: withdrawnValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const reopenWithdrawn = await durable.fetch(json("/coordination/proposals", progress("reopen-withdrawn-missing", createdValue.proposal.request_id, "in_progress", 4, sourceId)));
  const reopenWithdrawnValue = await reopenWithdrawn.json() as { proposal: { proposal_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 4, client_retry_id: "publish-reopen-withdrawn-missing", owner_label: "owner", proposal_id: reopenWithdrawnValue.proposal.proposal_id, revision: 1 }))).status).toBe(409);
  const reopenWithdrawnRevision = await durable.fetch(json(`/coordination/proposals/${reopenWithdrawnValue.proposal.proposal_id}/revisions`, progress("reopen-withdrawn-reason", createdValue.proposal.request_id, "in_progress", 4, sourceId, { reopen_reason: "The withdrawn work is active again after a new owner request." })));
  const reopenWithdrawnRevisionValue = await reopenWithdrawnRevision.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 4, client_retry_id: "publish-reopen-withdrawn-reason", owner_label: "owner", proposal_id: reopenWithdrawnRevisionValue.proposal.proposal_id, revision: reopenWithdrawnRevisionValue.proposal.revision }))).status).toBe(201);
});

test("requires an explicit progress rebase after a competing report is published", async () => {
  const { room: durable } = await room();
  const initialized = await durable.fetch(json("/initialize", { management_hash: await hashCapability("owner-token"), initial: { content: "source", author: "a", display_name: "A", semantic_type: "message" } }));
  const sourceId = (await initialized.json() as { id: string }).id;
  const created = await durable.fetch(json("/coordination/proposals", proposal("stale-progress-create", sourceId)));
  const createdValue = await created.json() as { proposal: { proposal_id: string; request_id: string } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 0, client_retry_id: "stale-progress-create-publish", owner_label: "owner", proposal_id: createdValue.proposal.proposal_id, revision: 1 }))).status).toBe(201);
  const first = await durable.fetch(json("/coordination/proposals", progress("stale-progress-first", createdValue.proposal.request_id, "in_progress", 1, sourceId)));
  const firstValue = await first.json() as { proposal: { proposal_id: string; revision: number } };
  const second = await durable.fetch(json("/coordination/proposals", progress("stale-progress-second", createdValue.proposal.request_id, "blocked", 1, sourceId)));
  const secondValue = await second.json() as { proposal: { proposal_id: string; revision: number } };
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "stale-progress-first-publish", owner_label: "owner", proposal_id: firstValue.proposal.proposal_id, revision: firstValue.proposal.revision }))).status).toBe(201);
  const stale = await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 1, client_retry_id: "stale-progress-second-publish", owner_label: "owner", proposal_id: secondValue.proposal.proposal_id, revision: secondValue.proposal.revision }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "stale_revision", current_revision: 2 } });
  const rebased = await durable.fetch(json(`/coordination/proposals/${secondValue.proposal.proposal_id}/revisions`, progress("stale-progress-rebased", createdValue.proposal.request_id, "blocked", 2, sourceId, { reopen_reason: "The competing progress report left this blocker unresolved." })));
  const rebasedValue = await rebased.json() as { proposal: { proposal_id: string; revision: number } };
  expect(rebased.status).toBe(201);
  expect((await durable.fetch(json("/coordination/publish?token=owner-token", { base_revision: 2, client_retry_id: "stale-progress-rebased-publish", owner_label: "owner", proposal_id: rebasedValue.proposal.proposal_id, revision: rebasedValue.proposal.revision }))).status).toBe(201);
});

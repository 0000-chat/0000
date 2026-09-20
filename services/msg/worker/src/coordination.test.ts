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

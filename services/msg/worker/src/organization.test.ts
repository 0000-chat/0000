import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { DurableRoomService, type RoomStub } from "./room-service";
import { OrganizationService } from "./organization-service";
import { createWorker } from "./worker";

mock.module("cloudflare:workers", () => ({ DurableObject: class {
  protected ctx: unknown;
  constructor(ctx: unknown) { this.ctx = ctx; }
} }));

class Context {
  readonly database = new Database(":memory:");
  alarmAt?: number;
  readonly storage = {
    sql: { exec: (query: string, ...values: unknown[]): Iterable<unknown> => {
      if (!values.length && query.includes(";")) { this.database.exec(query); return []; }
      const statement = this.database.query(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) return statement.all(...values as never[]);
      statement.run(...values as never[]); return [];
    } },
    transactionSync: <T>(callback: () => T) => this.database.transaction(callback)(),
    setAlarm: async (value: number) => { this.alarmAt = value; },
    deleteAlarm: async () => { this.alarmAt = undefined; },
  };
  getWebSockets() { return []; }
  waitUntil() {}
}

async function setup() {
  const { ConversationRoom } = await import("./conversation-room");
  const { ChatGroup } = await import("./chat-group");
  let now = Date.now();
  const rooms = new Map<string, RoomStub>();
  const groups = new Map<string, RoomStub>();
  const roomNamespace = { getByName(name: string) {
    if (!rooms.has(name)) rooms.set(name, new ConversationRoom(new Context() as never, {}, () => now));
    return rooms.get(name)!;
  } };
  const groupNamespace = { getByName(name: string) {
    if (!groups.has(name)) groups.set(name, new ChatGroup(new Context() as never, {}, () => now));
    return groups.get(name)!;
  } };
  const roomService = new DurableRoomService(roomNamespace, "http://localhost:8791");
  const service = new OrganizationService(roomNamespace, groupNamespace, "http://localhost:8791");
  const create = (title: string) => roomService.create({ body: { kind: "json", value: { content: `${title} first message`, title } } });
  return { service, create, roomService, rooms, roomNamespace, advance: (ms: number) => { now += ms; } };
}

test("shared groups deduplicate membership without exposing groups from a room", async () => {
  const { service, create, roomService } = await setup();
  const a = await create("Strategy"), b = await create("Research");
  const group = await service.createGroup({ name: "Launch" });
  const id = new URL(group.group_url).pathname.split("/").pop()!;
  await service.addToGroup(id, { conversation_url: a.conversation_url });
  await service.addToGroup(id, { conversation_url: b.conversation_url });
  await service.addToGroup(id, { conversation_url: b.conversation_url });
  expect((await service.readGroup(id)).chats.map(chat => chat.title)).toEqual(["Strategy", "Research"]);
  const read = await roomService.read({ room: a.room.id, after: 0 });
  expect(JSON.stringify(read)).not.toContain(group.group_url);
  expect(JSON.stringify(read)).not.toContain(b.conversation_url);
  await service.removeFromGroup(id, b.room.id);
  expect((await service.readGroup(id)).chats).toHaveLength(1);
  expect((await roomService.read({ room: b.room.id, after: 0 })).messages).toHaveLength(1);
});

test("source links are reciprocal and never mix messages or extend room expiry", async () => {
  const { service, create, roomService } = await setup();
  const source = await create("Strategy"), detail = await create("Pricing");
  const body = { conversation_url: detail.conversation_url, source_message: 1 };
  await service.link(source.room.id, body);
  await service.link(source.room.id, body);
  const a = await service.readLinks(source.room.id), b = await service.readLinks(detail.room.id);
  expect(a.links).toEqual([expect.objectContaining({ kind: "branch", source_message: 1, conversation_url: detail.conversation_url })]);
  expect(b.links).toEqual([expect.objectContaining({ kind: "source", source_message: 1, conversation_url: source.conversation_url })]);
  await roomService.post({ room: detail.room.id, body: { kind: "json", value: { content: "A detailed answer" } } });
  const read = await roomService.read({ room: source.room.id, after: 0 });
  expect(read.messages).toHaveLength(1);
  expect(read.expires_at).toBe(source.expires_at!);
});

test("rejects foreign, management, self links and nonexistent source messages", async () => {
  const { service, create } = await setup();
  const a = await create("A"), b = await create("B");
  for (const conversation_url of ["https://evil.test/" + a.room.id, a.manage_url!, a.conversation_url, b.conversation_url + "?view=human"]) {
    await expect(service.link(a.room.id, { conversation_url })).rejects.toMatchObject({ status: 400 });
  }
  await expect(service.link(a.room.id, { conversation_url: b.conversation_url, source_message: 999 })).rejects.toMatchObject({ status: 400 });
  expect((await service.readLinks(b.room.id)).links).toHaveLength(0);
});

test("a retry repairs a partial reciprocal write without duplicates", async () => {
  const { service, create, rooms } = await setup();
  const a = await create("A"), b = await create("B");
  const original = rooms.get(b.room.id)!;
  rooms.set(b.room.id, { fetch: async request => request.method === "PUT" ? new Response("{}", { status: 503 }) : original.fetch(request) });
  await expect(service.link(a.room.id, { conversation_url: b.conversation_url })).rejects.toMatchObject({ status: 503 });
  rooms.set(b.room.id, original);
  await service.link(a.room.id, { conversation_url: b.conversation_url });
  expect((await service.readLinks(a.room.id)).links).toHaveLength(1);
  expect((await service.readLinks(b.room.id)).links).toHaveLength(1);
});

test("expired rooms become unavailable in groups; group reads do not extend group expiry", async () => {
  const { service, create, advance } = await setup();
  const a = await create("A"), group = await service.createGroup({ name: "Work" });
  const id = new URL(group.group_url).pathname.split("/").pop()!;
  await service.addToGroup(id, { conversation_url: a.conversation_url });
  advance(8 * 86400000);
  const read = await service.readGroup(id);
  expect(read.chats[0].status).toBe("unavailable");
  expect(read.chats[0].title).toBe("Unavailable conversation");
  advance(23 * 86400000);
  await expect(service.readGroup(id)).rejects.toMatchObject({ status: 410 });
});

test("organization routes enforce kill switches, rate limits, body bounds and same origin", async () => {
  const { service, roomService } = await setup();
  const request = (path: string, body: unknown, origin?: string) => new Request("http://localhost:8791" + path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  const disabled = createWorker(roomService, { organization: service, createDisabled: true });
  expect((await disabled.fetch(request("/groups", { name: "Work" }))).status).toBe(503);
  const blocked = createWorker(roomService, { organization: service, rateLimits: { creation: { limit: async () => ({ success: false }) } } });
  expect((await blocked.fetch(request("/groups", { name: "Work" }))).status).toBe(429);
  const worker = createWorker(roomService, { organization: service });
  expect((await worker.fetch(request("/groups", { name: "Work" }, "https://evil.test"))).status).toBe(403);
  expect((await worker.fetch(request("/groups", { name: "x".repeat(5000) }))).status).toBe(413);
  expect((await worker.fetch(request("/groups", { name: "\n" }))).status).toBe(400);
  const groupResponse = await worker.fetch(request("/groups", { name: "Work" }));
  const group = await groupResponse.json() as { group_url: string };
  const paused = createWorker(roomService, { organization: service, postDisabled: true });
  expect((await paused.fetch(request(new URL(group.group_url).pathname.replace("/g/", "/groups/") + "/chats", {}))).status).toBe(503);
});

test("collection bounds allow duplicate memberships and unlinking restores both sides", async () => {
  const { service, create } = await setup();
  const source = await create("Source"), group = await service.createGroup({ name: "Many chats" });
  const groupId = new URL(group.group_url).pathname.split("/").pop()!;
  let first: Awaited<ReturnType<typeof create>> | undefined;
  for (let index = 0; index < 50; index++) {
    const target = await create("Chat " + index);
    first ??= target;
    await service.link(source.room.id, { conversation_url: target.conversation_url });
    await service.addToGroup(groupId, { conversation_url: target.conversation_url });
  }
  await service.link(source.room.id, { conversation_url: first!.conversation_url });
  await service.addToGroup(groupId, { conversation_url: first!.conversation_url });
  const extra = await create("Extra");
  await expect(service.link(source.room.id, { conversation_url: extra.conversation_url })).rejects.toMatchObject({ status: 409 });
  await expect(service.addToGroup(groupId, { conversation_url: extra.conversation_url })).rejects.toMatchObject({ status: 409 });
  expect((await service.readLinks(extra.room.id)).links).toHaveLength(0);
  await service.unlink(source.room.id, first!.room.id);
  expect((await service.readLinks(first!.room.id)).links).toHaveLength(0);
  expect((await service.readLinks(source.room.id)).links).toHaveLength(49);
});

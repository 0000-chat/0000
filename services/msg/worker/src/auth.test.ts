import { expect, test } from "bun:test";

import { createMsgAuthenticator, MSG_PERMISSION_IDS, MSG_READ, MSG_WRITE, type MsgRoomAuthPort } from "./auth";
import { createWorker } from "./worker";
import type { CreateRoomResponse, RoomService } from "./protocol";

const authority = "platform-test";
const audience = "msg-test";

interface GuestRecord { readonly bootstrap: string; readonly guestId: string; }

function responseForPlatform(): { assertions: Record<string, unknown>[]; fetch: typeof fetch; credentials: Map<string, { guestId: string; capabilities: string[]; grantId: string }>; guests: GuestRecord[] } {
  const guests: GuestRecord[] = [];
  const assertions: Record<string, unknown>[] = [];
  const credentials = new Map<string, { guestId: string; capabilities: string[]; grantId: string }>();
  let guestSequence = 0;
  let grantSequence = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input.toString());
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === "/internal/v1/guests") {
      const guest = { bootstrap: `bootstrap-${++guestSequence}`, guestId: `guest-${guestSequence}` };
      guests.push(guest);
      return Response.json({ status: "success", guestId: guest.guestId, authority, audience, purpose: "guest_control", bootstrapCredential: guest.bootstrap }, { status: 201 });
    }
    if (url.pathname === "/internal/v1/guests/resolve") {
      const guest = guests.find((candidate) => candidate.bootstrap === body.bootstrapCredential);
      return guest
        ? Response.json({ status: "success", guestId: guest.guestId, authority, audience, purpose: "guest_control" })
        : Response.json({ status: "invalid_guest_control" }, { status: 401 });
    }
    if (url.pathname === "/internal/v1/guest-grants" || /\/internal\/v1\/guest-grants\/[^/]+\/renew/u.test(url.pathname)) {
      if (body.assertion && typeof body.assertion === "object" && !Array.isArray(body.assertion)) assertions.push(body.assertion as Record<string, unknown>);
      const guest = guests.find((candidate) => candidate.bootstrap === body.bootstrapCredential);
      if (!guest) return Response.json({ status: "invalid_guest_control" }, { status: 401 });
      const existingGrantId = /\/internal\/v1\/guest-grants\/([^/]+)\/renew/u.exec(url.pathname)?.[1];
      const grantId = existingGrantId ?? `grant-${++grantSequence}`;
      const credential = `credential-${grantId}`;
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities.filter((value): value is string => typeof value === "string") : [];
      credentials.set(credential, { guestId: guest.guestId, capabilities, grantId });
      return Response.json({
        status: "success",
        credential,
        credentialId: `credential-id-${grantId}`,
        grantId,
        principal: { version: 1, kind: "guest", authority, subjectId: guest.guestId, credentialId: `credential-id-${grantId}`, audience, capabilities, expiresAt: null, grantId, resourceIds: ["room-1"] },
      }, { status: 201 });
    }
    if (url.pathname === "/internal/v1/authenticate") {
      const credential = typeof body.credential === "string" ? body.credential : "";
      const grant = credentials.get(credential);
      if (!grant) return Response.json({ status: "invalid_credential" }, { status: 401 });
      return Response.json({ status: "authenticated", principal: { version: 1, kind: "guest", authority, subjectId: grant.guestId, credentialId: `credential-id-${grant.grantId}`, audience, capabilities: grant.capabilities, expiresAt: null, grantId: grant.grantId, resourceIds: ["room-1"] } });
    }
    return Response.json({ status: "authority_unavailable" }, { status: 503 });
  };
  return { assertions, credentials, fetch: fetcher, guests };
}

function accessPort(): MsgRoomAuthPort {
  const grants = new Map<string, { capabilities: string[]; grantId?: string }>();
  return {
    async proveLink(input) {
      if (input.room !== "room-1") return null;
      if (input.source === "management" && input.token !== "manage") return null;
      return { source: input.source };
    },
    async recordGrant(input) { grants.set(`${input.guestId}:${input.source}`, { capabilities: [...input.capabilities], ...(input.grantId ? { grantId: input.grantId } : {}) }); },
    async checkGrant(input) {
      const grant = grants.get(`${input.guestId}:${input.source}`) ?? (input.source === "public" ? grants.get(`${input.guestId}:owner`) : undefined);
      return (!input.grantId || grant?.grantId === input.grantId) && (grant?.capabilities ?? []).includes(input.action === "read" ? MSG_READ : input.action === "write" ? MSG_WRITE : "msg:manage");
    },
    async findGrant(input) {
      const entries = [...grants.entries()].filter(([key, grant]) => {
        const [guestId, source] = key.split(":");
        return guestId === input.guestId && (input.source === undefined || source === input.source) && (input.grantId === undefined || grant.grantId === input.grantId);
      });
      const entry = entries[0];
      if (!entry) return null;
      const source = entry[0].split(":")[1] as "owner" | "public" | "management";
      return { source, ...(entry[1].grantId ? { grantId: entry[1].grantId } : {}), capabilities: entry[1].capabilities, active: true };
    },
  };
}

function createdRoom(): CreateRoomResponse {
  return {
    protocol_version: 1,
    room: { id: "room-1", created_at: "2026-09-19T00:00:00.000Z", expires_at: "2026-09-26T00:00:00.000Z", protocol_version: 1 },
    conversation_url: "https://msg.0000.chat/room-1",
    share_message: "Join my conversation:\nhttps://msg.0000.chat/room-1",
    manage_url: "https://msg.0000.chat/manage/room-1/manage",
    latest_message: 1,
    expires_at: "2026-09-26T00:00:00.000Z",
    wait: { after: 1, command: "wait", requires_user_consent: true },
  };
}

function mergeCookieHeaders(...headers: string[]): string {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const cookie of header.split("; ").filter(Boolean)) {
      const separator = cookie.indexOf("=");
      if (separator > 0) cookies.set(cookie.slice(0, separator), cookie);
    }
  }
  return [...cookies.values()].join("; ");
}

function readResult() {
  return { protocol_version: 1 as const, messages: [], latest_message: 1, expires_at: "2026-09-26T00:00:00.000Z", conversation_url: "https://msg.0000.chat/room-1", share_message: "share", wait: { after: 1, command: "wait", requires_user_consent: true as const } };
}

test("resolves guest control, attests owner or participant, and scopes cookies by room", async () => {
  const platform = responseForPlatform();
  const serviceCalls: Array<{ kind: string; guestId?: string; source?: string }> = [];
  const service: RoomService = {
    async create(input) { serviceCalls.push({ kind: "create", guestId: input.ownerGuestId }); return createdRoom(); },
    async read(input) { serviceCalls.push({ kind: "read", guestId: input.auth?.guestId, source: input.auth?.source }); return readResult(); },
    async post(input) { serviceCalls.push({ kind: "post", guestId: input.auth?.guestId, source: input.auth?.source }); return { protocol_version: 1, message: { id: "m", sequence: 2, content: "ok", created_at: "2026-09-19T00:00:00.000Z" }, expires_at: "2026-09-26T00:00:00.000Z", wait: { after: 2, command: "wait", requires_user_consent: true } }; },
  };
  const auth = createMsgAuthenticator({ baseUrl: "https://platform.test", authority, audience, guestGrantIssuer: "issuer", serviceVerifier: "verifier", fetch: platform.fetch }, accessPort());
  const worker = createWorker(service, { auth });

  const created = await worker.fetch(new Request("https://msg.0000.chat/", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ content: "first", author: "a", display_name: "A", semantic_type: "message" }) }));
  expect(created.status).toBe(201);
  const setCookies = created.headers.getSetCookie?.() ?? (created.headers.get("set-cookie") ?? "").split(/, (?=[^;]+=)/u).filter(Boolean);
  expect(setCookies.some((cookie) => cookie.startsWith("msg_guest_control=") && cookie.includes("Path=/"))).toBe(true);
  expect(setCookies.some((cookie) => cookie.startsWith("msg_resource=") && cookie.includes("Path=/room-1"))).toBe(true);
  const cookieHeader = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");

  const read = await worker.fetch(new Request("https://msg.0000.chat/room-1", { headers: { accept: "application/json", cookie: cookieHeader } }));
  expect(read.status).toBe(200);
  expect(serviceCalls.at(-1)).toMatchObject({ kind: "read", source: "owner", guestId: "guest-1" });

  const posted = await worker.fetch(new Request("https://msg.0000.chat/room-1", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", cookie: cookieHeader }, body: JSON.stringify({ content: "second", author: "b", display_name: "B", semantic_type: "message" }) }));
  expect(posted.status).toBe(201);
  expect(serviceCalls.at(-1)).toMatchObject({ kind: "post", source: "owner", guestId: "guest-1" });

  const participant = await worker.fetch(new Request("https://msg.0000.chat/room-1", { headers: { accept: "application/json" } }));
  expect(participant.status).toBe(200);
  const participantCookies = participant.headers.getSetCookie?.() ?? [];
  expect(participantCookies.some((cookie) => cookie.includes("Path=/room-1"))).toBe(true);
  expect(serviceCalls.at(-1)?.guestId).toBe("guest-2");
  expect(serviceCalls.some((call) => call.guestId === "guest-2" && call.source === "owner")).toBe(false);
  const participantCookieHeader = participantCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
  const participantPost = await worker.fetch(new Request("https://msg.0000.chat/room-1", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", cookie: participantCookieHeader },
    body: JSON.stringify({ content: "participant", author: "p", display_name: "P", semantic_type: "message" }),
  }));
  expect(participantPost.status).toBe(201);
  expect(serviceCalls.at(-1)).toMatchObject({ kind: "post", source: "public", guestId: "guest-2" });
  expect(platform.assertions).toEqual(expect.arrayContaining([
    { kind: "owner", storedOwnerId: "guest-1", permissionId: MSG_PERMISSION_IDS.owner },
    { kind: "participant", permissionId: MSG_PERMISSION_IDS.public },
  ]));
});

test("rejects invalid resource proof without silently creating a replacement grant", async () => {
  const platform = responseForPlatform();
  const auth = createMsgAuthenticator({ baseUrl: "https://platform.test", authority, audience, guestGrantIssuer: "issuer", serviceVerifier: "verifier", fetch: platform.fetch }, accessPort());
  const worker = createWorker({ create: async () => createdRoom(), read: async () => readResult() }, { auth });
  const created = await worker.fetch(new Request("https://msg.0000.chat/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "first", author: "a", display_name: "A", semantic_type: "message" }) }));
  const setCookies = created.headers.getSetCookie?.() ?? [];
  const control = setCookies.find((cookie) => cookie.startsWith("msg_guest_control="))?.split(";", 1)[0] ?? "";
  const denied = await worker.fetch(new Request("https://msg.0000.chat/room-1", { headers: { accept: "application/json", cookie: `${control}; msg_resource=revoked` } }));
  expect(denied.status).toBe(401);
  expect(platform.credentials.size).toBe(1);
});

test("only an explicit recovery query replaces a stale resource cookie after link proof", async () => {
  const platform = responseForPlatform();
  const auth = createMsgAuthenticator({ baseUrl: "https://platform.test", authority, audience, guestGrantIssuer: "issuer", serviceVerifier: "verifier", fetch: platform.fetch }, accessPort());
  const worker = createWorker({ create: async () => createdRoom(), read: async () => readResult() }, { auth });
  const created = await worker.fetch(new Request("https://msg.0000.chat/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "first", author: "a", display_name: "A", semantic_type: "message" }) }));
  const setCookies = created.headers.getSetCookie?.() ?? [];
  const control = setCookies.find((cookie) => cookie.startsWith("msg_guest_control="))?.split(";", 1)[0] ?? "";
  const denied = await worker.fetch(new Request("https://msg.0000.chat/room-1", { headers: { accept: "application/json", cookie: `${control}; msg_resource=revoked` } }));
  expect(denied.status).toBe(401);
  const recovered = await worker.fetch(new Request("https://msg.0000.chat/room-1?recover=1", { headers: { accept: "application/json", cookie: `${control}; msg_resource=revoked` } }));
  expect(recovered.status).toBe(200);
  expect(recovered.headers.getSetCookie?.().some((cookie) => cookie.startsWith("msg_resource=credential-"))).toBe(true);
  expect(platform.credentials.size).toBe(2);
});

test("renews an active participant grant during explicit recovery", async () => {
  const platform = responseForPlatform();
  const auth = createMsgAuthenticator({ baseUrl: "https://platform.test", authority, audience, guestGrantIssuer: "issuer", serviceVerifier: "verifier", fetch: platform.fetch }, accessPort());
  const worker = createWorker({ create: async () => createdRoom(), read: async () => readResult() }, { auth });
  const created = await worker.fetch(new Request("https://msg.0000.chat/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "first", author: "first", display_name: "First", semantic_type: "message" }) }));
  const setCookies = created.headers.getSetCookie?.() ?? [];
  const control = setCookies.find((cookie) => cookie.startsWith("msg_guest_control="))?.split(";", 1)[0] ?? "";

  const firstRecovery = await worker.fetch(new Request("https://msg.0000.chat/room-1?recover=1", { headers: { accept: "application/json", cookie: control } }));
  expect(firstRecovery.status).toBe(200);
  expect(platform.credentials.size).toBe(2);

  const secondRecovery = await worker.fetch(new Request("https://msg.0000.chat/room-1?recover=1", { headers: { accept: "application/json", cookie: `${control}; msg_resource=lost` } }));
  expect(secondRecovery.status).toBe(200);
  expect(secondRecovery.headers.getSetCookie?.().some((cookie) => cookie.startsWith("msg_resource=credential-grant-2"))).toBe(true);
  expect(platform.credentials.size).toBe(2);
  expect(platform.assertions.filter((assertion) => assertion.kind === "participant")).toHaveLength(2);
});

test("keeps public and management grants independent for one guest", async () => {
  const platform = responseForPlatform();
  const serviceCalls: Array<{ kind: string; source?: string }> = [];
  const service: RoomService = {
    async create() { return createdRoom(); },
    async read(input) { serviceCalls.push({ kind: "read", source: input.auth?.source }); return readResult(); },
    async manage(input) { serviceCalls.push({ kind: input.method, source: input.auth?.source }); return { protocol_version: 1, expires_at: "2026-09-26T00:00:00.000Z" }; },
  };
  const auth = createMsgAuthenticator({ baseUrl: "https://platform.test", authority, audience, guestGrantIssuer: "issuer", serviceVerifier: "verifier", fetch: platform.fetch }, accessPort());
  const worker = createWorker(service, { auth });
  const created = await worker.fetch(new Request("https://msg.0000.chat/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "first", author: "a", display_name: "A", semantic_type: "message" }) }));
  const initialCookies = (created.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";", 1)[0]).join("; ");
  const recovered = await worker.fetch(new Request("https://msg.0000.chat/room-1?recover=1", { headers: { accept: "application/json", cookie: initialCookies.split("; ").filter((cookie) => cookie.startsWith("msg_guest_control=")).join("; ") } }));
  expect(recovered.status).toBe(200);
  const publicCookies = mergeCookieHeaders(initialCookies, ...(recovered.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";", 1)[0]));
  const management = await worker.fetch(new Request("https://msg.0000.chat/manage/room-1/manage", { headers: { accept: "application/json", cookie: publicCookies } }));
  expect(management.status).toBe(200);
  const managementCookies = mergeCookieHeaders(publicCookies, ...(management.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";", 1)[0]));
  const publicRead = await worker.fetch(new Request("https://msg.0000.chat/room-1", { headers: { accept: "application/json", cookie: publicCookies } }));
  const managementRead = await worker.fetch(new Request("https://msg.0000.chat/manage/room-1/manage", { headers: { accept: "application/json", cookie: managementCookies } }));
  expect(publicRead.status).toBe(200);
  expect(managementRead.status).toBe(200);
  expect(serviceCalls).toEqual(expect.arrayContaining([
    { kind: "read", source: "public" },
    { kind: "GET", source: "management" },
  ]));
  expect(platform.assertions).toEqual(expect.arrayContaining([
    { kind: "participant", permissionId: MSG_PERMISSION_IDS.public },
    { kind: "participant", permissionId: MSG_PERMISSION_IDS.management },
  ]));
});

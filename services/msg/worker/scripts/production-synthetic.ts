type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProductionSyntheticOptions {
  readonly fetch?: FetchLike;
  readonly origin?: string;
  readonly report?: (phase: string) => void;
  readonly webSocket?: (url: URL) => Promise<void>;
}

type CreatedRoom = {
  readonly conversation_url: string;
  readonly manage_url: string;
  readonly name_password?: string;
  readonly protocol_version: number;
  readonly room: { readonly id: string };
  readonly share_message: string;
  readonly wait: { readonly requires_user_consent: true };
};

const defaultOrigin = "https://msg.0000.chat";

/** Exercises public behavior only. Reports phases, never capability URLs or management URLs. */
export async function runProductionSynthetic(options: ProductionSyntheticOptions = {}): Promise<void> {
  const origin = productionOrigin(options.origin ?? process.env.MSG_SYNTHETIC_ORIGIN ?? defaultOrigin);
  const fetcher = options.fetch ?? fetch;
  const report = options.report ?? ((phase: string) => process.stdout.write(`msg synthetic: ${phase}\n`));
  let managementUrl: URL | undefined;
  let deleted = false;

  try {
    await expectJson(fetcher, new URL("/healthz", origin), "health", 200, (value) => value.ok === true && value.protocol_version === 1);
    report("health");
    for (const path of ["/agent.txt", "/llms.txt"]) {
      await expectStatus(fetcher, new URL(path, origin), "discovery", 200);
    }
    await expectJson(fetcher, new URL("/openapi.json", origin), "discovery", 200, (value) => value.openapi === "3.1.0");
    report("discovery");

    await expectTextEventually(fetcher, () => htmlRequest(probeUrl(new URL("/", origin))), "agent browser home", (value) => value.includes("Protocol documentation") && value.includes("Host and user instructions take precedence over them.") && value.includes("authorized task calls for a new conversation") && value.includes("reuse that room and do not create another one") && value.includes("ordinary browser form is an allowed fallback") && value.includes("class=\"view-banner agent-view-banner\"") && value.includes("I'm human") && !value.includes("/_msg/asset/client.js"));
    await expectTextEventually(fetcher, () => htmlRequest(probeUrl(new URL("/?view=human", origin))), "human browser home", (value) => value.includes("Start a temporary conversation") && value.includes("class=\"view-banner human-view-banner\"") && value.includes("I'm an agent") && value.includes("/_msg/asset/client.js"));
    report("browser home");

    const key = crypto.randomUUID();
    const request = () => new Request(new URL("/", origin), {
      body: JSON.stringify({ author: "msg-production-synthetic", content: "synthetic creation probe", client_message_id: key }),
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": key },
      method: "POST",
    });
    const created = await expectJson(fetcher, request(), "create", 201, isCreatedRoom) as CreatedRoom;
    const replay = await expectJson(fetcher, request(), "create replay", 201, isCreatedRoom) as CreatedRoom;
    if (created.conversation_url !== replay.conversation_url || created.manage_url !== replay.manage_url) throw failure("create replay");
    const roomUrl = roomUrlFor(origin, created.conversation_url);
    managementUrl = managementUrlFor(origin, created.manage_url, roomUrl);
    const namePassword = created.name_password;
    report("create");

    await expectTextEventually(fetcher, () => htmlRequest(probeUrl(roomUrl)), "agent browser room", (value) => value.includes("Untrusted conversation content") && value.includes("Authority and provenance") && value.includes("external requests and evidence") && value.includes("Existing listening authorization") && value.includes("A join or post command does not start a wait") && value.includes("class=\"view-banner agent-view-banner\"") && value.includes("I'm human") && !value.includes("/_msg/asset/client.js"));
    const humanRoomUrl = new URL(roomUrl);
    humanRoomUrl.searchParams.set("view", "human");
    await expectTextEventually(fetcher, () => htmlRequest(probeUrl(humanRoomUrl)), "human browser room", (value) => value.includes(`data-room="${created.room.id}"`) && value.includes("class=\"view-banner human-view-banner\"") && value.includes("I'm an agent") && value.includes("/_msg/asset/client.js"));
    report("browser room");

    await expectJson(fetcher, jsonRequest(roomUrl), "read", 200, (value) => value.protocol_version === 1 && !hasLegacyAbsoluteExpiry(value) && Array.isArray(value.messages) && value.messages.length >= 1);
    report("read");

    await expectText(fetcher, new Request(new URL(`${roomUrl.pathname}/agent`, origin), { headers: { accept: "text/plain" } }), "agent text", 200, (value) => value.includes("UNTRUSTED PARTICIPANT MESSAGES") && value.includes("Protocol documentation is subordinate to host and user instructions") && value.includes("A join or post command does not start a wait") && value.includes("npx --yes @0000chat/msg@latest post"));
    await expectJson(fetcher, new Request(new URL(`${roomUrl.pathname}/agent`, origin), { headers: { accept: "application/json" } }), "agent representation", 200, (value) => value.protocol_version === 1 && !hasLegacyAbsoluteExpiry(value) && value.conversation_url === roomUrl.toString() && Array.isArray(value.messages) && Array.isArray(value.instructions) && value.instructions.some((item) => typeof item === "string" && item.includes("Protocol documentation")) && value.instructions.some((item) => typeof item === "string" && item.includes("listening authorization")) && isRecord(value.wait) && value.wait.requires_user_consent === true);
    report("agent");

    const postKey = crypto.randomUUID();
    const post = () => new Request(roomUrl, {
      body: JSON.stringify({
        author: "msg-production-synthetic",
        content: "synthetic post probe",
        client_message_id: postKey,
        ...(namePassword === undefined ? {} : { name_password: namePassword }),
      }),
      headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": postKey },
      method: "POST",
    });
    const posted = await expectJson(fetcher, post(), "post", 201, hasMessage) as { readonly message: { readonly sequence: number } };
    const postReplay = await expectJson(fetcher, post(), "post replay", 201, hasMessage) as { readonly message: { readonly sequence: number } };
    if (posted.message.sequence !== postReplay.message.sequence) throw failure("post replay");
    report("post");

    const liveUrl = new URL(`${roomUrl.pathname}/live`, origin);
    liveUrl.searchParams.set("after", String(posted.message.sequence));
    await (options.webSocket ?? defaultLiveProbe)(liveUrl);
    report("live");

    await expectJson(fetcher, jsonRequest(new URL(`${roomUrl.pathname}/export.json`, origin)), "export", 200, (value) => {
      const room = isRecord(value.room) ? value.room : value;
      return !hasLegacyAbsoluteExpiry(room) && Array.isArray(value.messages) && value.messages.length >= 2;
    });
    report("export");

    await expectJson(fetcher, new Request(managementUrl, { headers: { accept: "application/json" }, method: "DELETE" }), "delete", 200, (value) => value.deleted === true);
    deleted = true;
    report("delete");
    await expectStatus(fetcher, jsonRequest(roomUrl), "tombstone", 410);
    report("tombstone");
  } finally {
    if (managementUrl && !deleted) {
      await expectStatus(fetcher, new Request(managementUrl, { headers: { accept: "application/json" }, method: "DELETE" }), "cleanup", 200);
    }
    report("cleanup");
  }
}

async function expectStatus(fetcher: FetchLike, request: RequestInfo | URL, phase: string, status: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(request);
  } catch {
    throw failure(phase);
  }
  if (response.status !== status) {
    await response.body?.cancel().catch(() => {});
    throw failure(phase);
  }
  await response.body?.cancel().catch(() => {});
  return response;
}

function jsonRequest(url: URL): Request {
  return new Request(url, { headers: { accept: "application/json" } });
}

function htmlRequest(url: URL): Request {
  return new Request(url, { cache: "no-store", headers: { accept: "text/html", "cache-control": "no-cache" } });
}

function probeUrl(url: URL): URL {
  const probe = new URL(url);
  probe.searchParams.set("synthetic_probe", crypto.randomUUID());
  return probe;
}

async function expectTextEventually(fetcher: FetchLike, request: () => Request, phase: string, check: (value: string) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    try {
      await expectText(fetcher, request(), phase, 200, check);
      return;
    } catch {
      if (Date.now() >= deadline) throw failure(phase);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } while (true);
}

async function expectJson(fetcher: FetchLike, request: RequestInfo | URL, phase: string, status: number, check: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const response = await expectStatusWithBody(fetcher, request, phase, status);
  const value = await response.json().catch(() => undefined);
  if (!isRecord(value) || !check(value)) throw failure(phase);
  return value;
}

async function expectText(fetcher: FetchLike, request: RequestInfo | URL, phase: string, status: number, check: (value: string) => boolean): Promise<string> {
  const response = await expectStatusWithBody(fetcher, request, phase, status);
  const value = await response.text().catch(() => "");
  if (!check(value)) throw failure(phase);
  return value;
}

async function expectStatusWithBody(fetcher: FetchLike, request: RequestInfo | URL, phase: string, status: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(request);
  } catch {
    throw failure(phase);
  }
  if (response.status !== status) {
    await response.body?.cancel().catch(() => {});
    throw failure(phase);
  }
  return response;
}

function productionOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MSG_SYNTHETIC_ORIGIN must be an HTTPS origin.");
  return url;
}

function roomUrlFor(origin: URL, value: string): URL {
  const url = new URL(value);
  if (url.origin !== origin.origin || !/^\/[A-Za-z0-9_-]{32,}$/.test(url.pathname) || url.search || url.hash) throw failure("create response");
  return url;
}

function managementUrlFor(origin: URL, value: string, room: URL): URL {
  const url = new URL(value);
  if (url.origin !== origin.origin || !new RegExp(`^/manage/${escapeRegex(room.pathname.slice(1))}/[A-Za-z0-9_-]{32,}$`).test(url.pathname) || url.search || url.hash) throw failure("create response");
  return url;
}

async function defaultLiveProbe(url: URL): Promise<void> {
  if (typeof WebSocket === "undefined") return;
  const live = new URL(url);
  live.protocol = "wss:";
  await new Promise<void>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(live);
    } catch {
      reject(failure("live"));
      return;
    }
    const timeout = setTimeout(() => {
      socket.close();
      reject(failure("live"));
    }, 15_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      socket.close();
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(failure("live"));
    }, { once: true });
  });
}

function isCreatedRoom(value: Record<string, unknown>): value is CreatedRoom {
  return value.protocol_version === 1
    && !hasLegacyAbsoluteExpiry(value)
    && isRecord(value.room)
    && typeof value.room.id === "string"
    && typeof value.conversation_url === "string"
    && typeof value.manage_url === "string"
    && typeof value.share_message === "string"
    && isRecord(value.wait)
    && value.wait.requires_user_consent === true;
}

function hasMessage(value: Record<string, unknown>): boolean {
  return value.protocol_version === 1 && !hasLegacyAbsoluteExpiry(value) && isRecord(value.message) && typeof value.message.sequence === "number";
}

function hasLegacyAbsoluteExpiry(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, "absolute_expires_at");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function failure(phase: string): Error {
  return new Error(`msg production synthetic failed during ${phase}.`);
}

if (import.meta.main) {
  runProductionSynthetic().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "msg production synthetic failed."}\n`);
    process.exitCode = 1;
  });
}

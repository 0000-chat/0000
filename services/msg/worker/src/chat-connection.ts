import { DurableObject } from "cloudflare:workers";
import { ERROR_CODES, ProtocolError, type ErrorCode } from "./errors";
import { CAPABILITY_PATTERN, invalidOrganization, organizationObject, type ChatLink, type ChatOverview } from "./organization-domain";
import type { RoomNamespace, RoomStub } from "./room-service";

export interface ChatConnectionEnvironment { readonly ConversationRoom: RoomNamespace; }

/** One coordinator per unordered pair. Rooms remain the only durable link store. */
export class ChatConnection extends DurableObject<ChatConnectionEnvironment> {
  constructor(ctx: DurableObjectState, private readonly config: ChatConnectionEnvironment) { super(ctx, config); }

  async fetch(request: Request): Promise<Response> {
    // The critical section includes every awaited room call. A per-request lock
    // in the Worker would not protect mutations received by another isolate.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (request.method !== "POST" || (path !== "/link" && path !== "/unlink")) throw new ProtocolError(ERROR_CODES.notFound, "Connection route not found.", 404);
        let value: unknown;
        try { value = await request.json(); } catch { invalidOrganization("A JSON object is required."); }
        const input = organizationObject(value), room = input.room, target = input.target, source = input.source_message;
        if (typeof room !== "string" || !CAPABILITY_PATTERN.test(room) || typeof target !== "string" || !CAPABILITY_PATTERN.test(target) || room === target) invalidOrganization("Choose two different conversations.");
        if (source !== undefined && (path === "/unlink" || !Number.isSafeInteger(source) || (source as number) < 1)) invalidOrganization("Choose an existing source message.");
        if (path === "/unlink") {
          await this.unlink(room, target);
          return Response.json({ removed: true });
        }
        await this.link(room, target, source as number | undefined);
        return Response.json({ connected: true });
      } catch (error) {
        // An exception escaping blockConcurrencyWhile resets the object. Return
        // failures here so queued retries can repair a partially written pair.
        if (error instanceof ProtocolError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
        return Response.json({ error: { code: ERROR_CODES.serviceUnavailable, message: "The connection could not be completed. Retry the identical request to finish both links." } }, { status: 503 });
      }
    });
  }

  private async link(room: string, target: string, source: number | undefined): Promise<void> {
    const from = this.config.ConversationRoom.getByName(room), to = this.config.ConversationRoom.getByName(target);
    const [parent] = await Promise.all([call<ChatOverview>(from, "/overview"), call<ChatOverview>(to, "/overview")]);
    if (source !== undefined && source > parent.latest_message) invalidOrganization("The source message does not exist.");
    const outgoing: ChatLink = { room: target, kind: source === undefined ? "related" : "branch", source_message: source ?? null };
    const incoming: ChatLink = { room, kind: source === undefined ? "related" : "source", source_message: source ?? null };
    await Promise.all([call(from, "/links/check", "POST", outgoing), call(to, "/links/check", "POST", incoming)]);
    await call(from, "/links", "PUT", outgoing);
    await call(to, "/links", "PUT", incoming);
  }

  private async unlink(room: string, target: string): Promise<void> {
    const from = this.config.ConversationRoom.getByName(room), to = this.config.ConversationRoom.getByName(target);
    await call(from, "/overview");
    await call(from, `/links/${target}`, "DELETE");
    try { await call(to, `/links/${room}`, "DELETE"); }
    catch (error) { if (!(error instanceof ProtocolError) || ![404, 410].includes(error.status)) throw error; }
  }
}

async function call<T>(stub: RoomStub, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await stub.fetch(new Request(`https://internal${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  const value = await response.json() as T & { error?: { code: ErrorCode; message: string } };
  if (!response.ok) throw new ProtocolError(value.error?.code ?? ERROR_CODES.serviceUnavailable, value.error?.message ?? "The connection could not be completed. Retry to finish both links.", response.status);
  return value;
}

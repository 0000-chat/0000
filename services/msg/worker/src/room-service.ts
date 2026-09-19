import { ERROR_CODES, ProtocolError } from "./errors";
import { hashCapability, parseMessageInput, randomCapability, validateIdempotencyKey } from "./room-domain";
import { buildShareMessage, foregroundWait, PROTOCOL_VERSION, stripLegacyAbsoluteExpiry, type ClaimRoomInput, type ClaimRoomResponse, type CreateRoomInput, type CreateRoomResponse, type ExportRoomInput, type LiveRoomInput, type ManageRoomInput, type ManageRoomResponse, type PostMessageInput, type PostMessageResponse, type ReadRoomInput, type ReadRoomResponse, type RoomAccessContext, type RoomAccessSource, type RoomService } from "./protocol";

export interface RoomStub { fetch(request: Request): Promise<Response>; }
export interface RoomNamespace { getByName(name: string): RoomStub; }

/** Maps the public capability to one Durable Object without storing public room indexes. */
export class DurableRoomService implements RoomService {
  private readonly origin: string;

  constructor(
    private readonly rooms: RoomNamespace,
    origin: string,
    private readonly random: (values: Uint8Array) => Uint8Array = (values) => crypto.getRandomValues(values as Uint8Array<ArrayBuffer>) as Uint8Array,
  ) {
    this.origin = new URL(origin).origin;
  }

  async create(input: CreateRoomInput): Promise<CreateRoomResponse> {
    const room = input.plan?.room ?? randomCapability(this.random);
    const management = input.plan?.management ?? randomCapability(this.random);
    const initial = parseMessageInput(input.body);
    const response = await this.room(room).fetch(jsonRequest("/initialize", {
      initial,
      management_hash: await hashCapability(management),
      ...(input.ownerGuestId ? { owner_guest_id: input.ownerGuestId } : {}),
    }));
    const value = stripLegacyAbsoluteExpiry(await responseJson(response));
    const conversation_url = `${this.origin}/${room}`;
    const manage_url = `${this.origin}/manage/${room}/${management}`;
    return {
      protocol_version: PROTOCOL_VERSION,
      room: { id: room, created_at: value.created_at as string, expires_at: value.expires_at as string, protocol_version: PROTOCOL_VERSION },
      conversation_url,
      share_message: buildShareMessage(conversation_url),
      manage_url,
      latest_message: 1,
      expires_at: value.expires_at as string,
      wait: foregroundWait(this.origin, room, 1),
    };
  }

  async claim(input: ClaimRoomInput): Promise<ClaimRoomResponse> {
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest(`/claim?resource=${encodeURIComponent(input.room)}`, {
      idempotency_key: validateIdempotencyKey(input.idempotencyKey),
      request_digest: input.requestDigest,
      revoke_links: input.revokeLinks,
    }, input.auth)));
    return value as unknown as ClaimRoomResponse;
  }

  async read(input: ReadRoomInput): Promise<ReadRoomResponse> {
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(`https://room/read?after=${input.after}&resource=${encodeURIComponent(input.room)}`, { headers: authHeaders(input.auth) }))));
    const conversation_url = `${this.origin}/${input.room}`;
    const latest = value.latest_message as number;
    return {
      ...value,
      conversation_url,
      share_message: buildShareMessage(conversation_url),
      wait: foregroundWait(this.origin, input.room, latest),
    } as unknown as ReadRoomResponse;
  }

  async post(input: PostMessageInput): Promise<PostMessageResponse> {
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(jsonRequest(`/messages?resource=${encodeURIComponent(input.room)}`, {
      input: parseMessageInput(input.body), ...(input.idempotencyKey !== undefined ? { idempotency_key: validateIdempotencyKey(input.idempotencyKey) } : {}),
    }, input.auth))));
    const message = value.message as { sequence: number };
    return { ...value, wait: foregroundWait(this.origin, input.room, message.sequence) } as unknown as PostMessageResponse;
  }

  async manage(input: ManageRoomInput): Promise<ManageRoomResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/manage?token=${encodeURIComponent(input.token)}&resource=${encodeURIComponent(input.room)}`, { method: input.method, headers: authHeaders(input.auth) }))) as unknown as ManageRoomResponse;
  }

  async operatorDelete(room: string): Promise<void> {
    await responseJson(await this.room(room).fetch(new Request("https://room/operator-delete", { method: "POST" })));
  }

  async live(input: LiveRoomInput): Promise<Response> {
    return responsePassthrough(await this.room(input.room).fetch(new Request(`https://room/live?after=${input.after}&resource=${encodeURIComponent(input.room)}`, { headers: { upgrade: "websocket", ...authHeaders(input.auth) } })));
  }

  async exportRoom(input: ExportRoomInput): Promise<Response> {
    return responsePassthrough(await this.room(input.room).fetch(new Request(`https://room/export.${input.format === "json" ? "json" : "md"}?resource=${encodeURIComponent(input.room)}`, { headers: authHeaders(input.auth) })));
  }

  async proveLink(input: { readonly room: string; readonly source: RoomAccessSource; readonly token?: string }): Promise<{ readonly source: RoomAccessSource; readonly storedOwnerId?: string } | null> {
    const response = await this.room(input.room).fetch(jsonRequest("/access/proof", { source: input.source, ...(input.token === undefined ? {} : { token: input.token }) }));
    if (!response.ok) return null;
    const value = await response.json() as { source?: RoomAccessSource; stored_owner_id?: string };
    return value.source ? { source: value.source, ...(value.stored_owner_id ? { storedOwnerId: value.stored_owner_id } : {}) } : null;
  }

  async recordGrant(input: { readonly room: string; readonly guestId: string; readonly source: RoomAccessSource; readonly capabilities: readonly string[]; readonly grantId?: string }): Promise<void> {
    await responseJson(await this.room(input.room).fetch(jsonRequest("/access/record", { guest_id: input.guestId, source: input.source, capabilities: input.capabilities, ...(input.grantId ? { grant_id: input.grantId } : {}) })));
  }

  async checkGrant(input: { readonly room: string; readonly guestId: string; readonly source: RoomAccessSource; readonly action: "read" | "write" | "manage"; readonly grantId?: string }): Promise<boolean> {
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/access/check", { guest_id: input.guestId, source: input.source, action: input.action, ...(input.grantId ? { grant_id: input.grantId } : {}) })));
    return value.allowed === true;
  }

  async findGrant(input: { readonly room: string; readonly guestId: string; readonly source?: RoomAccessSource; readonly grantId?: string }): Promise<{ readonly source: RoomAccessSource; readonly grantId?: string; readonly capabilities: readonly string[]; readonly active: boolean } | null> {
    const response = await this.room(input.room).fetch(jsonRequest("/access/grant", { guest_id: input.guestId, ...(input.source ? { source: input.source } : {}), ...(input.grantId ? { grant_id: input.grantId } : {}) }));
    if (response.status === 404) return null;
    const value = await responseJson(response);
    const source = value.source;
    const capabilities = value.capabilities;
    if ((source !== "owner" && source !== "public" && source !== "management") || !Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string")) throw new ProtocolError(ERROR_CODES.internal, "The room returned an invalid access grant.", 500);
    return { source, ...(typeof value.grant_id === "string" ? { grantId: value.grant_id } : {}), capabilities, active: value.active === true };
  }

  private room(capability: string): RoomStub { return this.rooms.getByName(capability); }
}

function jsonRequest(path: string, value: unknown, auth?: RoomAccessContext): Request {
  return new Request(`https://room${path}`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(auth) }, body: JSON.stringify(value) });
}

function authHeaders(auth?: RoomAccessContext): Record<string, string> {
  if (!auth) return {};
  if (auth.kind === "organization") {
    return { authorization: `Bearer ${auth.credential}`, "x-msg-auth-kind": "organization" };
  }
  if (auth.kind === "claim") {
    return { authorization: `Bearer ${auth.credential}`, "x-msg-auth-kind": "claim", "x-msg-guest-id": auth.guestId };
  }
  return {
    ...(auth.credential ? { authorization: `Bearer ${auth.credential}` } : {}),
    "x-msg-auth-kind": "guest",
    "x-msg-guest-id": auth.guestId,
    "x-msg-source": auth.source,
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw await responseError(response);
  return await response.json() as Record<string, unknown>;
}

async function responsePassthrough(response: Response): Promise<Response> {
  if (response.status === 101) return response;
  if (response.ok) return new Response(response.body, response);
  throw await responseError(response);
}

async function responseError(response: Response): Promise<ProtocolError> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  const error = value.error as { code?: string; message?: string } | undefined;
  return new ProtocolError((error?.code as typeof ERROR_CODES[keyof typeof ERROR_CODES]) ?? ERROR_CODES.internal, error?.message ?? "The room could not complete the request.", response.status);
}

import { ERROR_CODES, ProtocolError } from "./errors";
import { hashCapability, parseMessageInput, randomCapability, validateIdempotencyKey } from "./room-domain";
import { buildShareMessage, foregroundWait, PROTOCOL_VERSION, stripLegacyAbsoluteExpiry, type CreateRoomInput, type CreateRoomResponse, type CreateWebhookInput, type CreateWebhookResponse, type ExportRoomInput, type ListWebhooksInput, type ListWebhooksResponse, type LiveRoomInput, type ManageRoomInput, type ManageRoomResponse, type PostMessageInput, type PostMessageResponse, type ReadRoomInput, type ReadRoomResponse, type RemoveWebhookInput, type RemoveWebhookResponse, type RoomService } from "./protocol";

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

  async read(input: ReadRoomInput): Promise<ReadRoomResponse> {
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(`https://room/read?after=${input.after}`))));
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
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(jsonRequest("/messages", {
      input: parseMessageInput(input.body), ...(input.idempotencyKey !== undefined ? { idempotency_key: validateIdempotencyKey(input.idempotencyKey) } : {}),
    }))));
    const message = value.message as { sequence: number };
    return { ...value, wait: foregroundWait(this.origin, input.room, message.sequence) } as unknown as PostMessageResponse;
  }

  async manage(input: ManageRoomInput): Promise<ManageRoomResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/manage?token=${encodeURIComponent(input.token)}`, { method: input.method }))) as unknown as ManageRoomResponse;
  }

  async createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResponse> {
    return responseJson(await this.room(input.room).fetch(jsonRequest("/webhooks", { url: input.url }))) as unknown as CreateWebhookResponse;
  }

  async listWebhooks(input: ListWebhooksInput): Promise<ListWebhooksResponse> {
    return responseJson(await this.room(input.room).fetch(new Request("https://room/webhooks"))) as unknown as ListWebhooksResponse;
  }

  async removeWebhook(input: RemoveWebhookInput): Promise<RemoveWebhookResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/webhooks/${encodeURIComponent(input.id)}`, { method: "DELETE" }))) as unknown as RemoveWebhookResponse;
  }

  async operatorDelete(room: string): Promise<void> {
    await responseJson(await this.room(room).fetch(new Request("https://room/operator-delete", { method: "POST" })));
  }

  async live(input: LiveRoomInput): Promise<Response> {
    return responsePassthrough(await this.room(input.room).fetch(new Request(`https://room/live?after=${input.after}`, { headers: { upgrade: "websocket" } })));
  }

  async exportRoom(input: ExportRoomInput): Promise<Response> {
    return responsePassthrough(await this.room(input.room).fetch(new Request(`https://room/export.${input.format === "json" ? "json" : "md"}`)));
  }

  private room(capability: string): RoomStub { return this.rooms.getByName(capability); }
}

function jsonRequest(path: string, value: unknown): Request {
  return new Request(`https://room${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
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

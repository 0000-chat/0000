import { ERROR_CODES, ProtocolError } from "./errors";
import { hashCapability, parseMessageInput, randomCapability, validateIdempotencyKey, validateRequestId } from "./room-domain";
import { buildShareMessage, foregroundWait, PROTOCOL_VERSION, stripLegacyAbsoluteExpiry, type CreateRoomInput, type CreateRoomResponse, type CreateWebhookInput, type CreateWebhookResponse, type EnrollPushInput, type ExportRoomInput, type GetPostMessageInput, type GetPostMessageResponse, type GetPostProbeInput, type GetPostProbeResponse, type ListWebhooksInput, type ListWebhooksResponse, type LiveRoomInput, type ManageRoomInput, type ManageRoomResponse, type ManageWebhookInput, type ManageWebhookResponse, type PostMessageInput, type PostMessageResponse, type PushEnrollmentInput, type PushEnrollmentResponse, type ReadRoomInput, type ReadRoomResponse, type RedeliverWebhookInput, type RedeliverWebhookResponse, type RemovePushEnrollmentResponse, type RemoveWebhookInput, type RemoveWebhookResponse, type RotateWebhookSecretResponse, type RoomService } from "./protocol";

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
    const query = new URLSearchParams({ after: String(input.after) });
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(`https://room/read?${query}`))));
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
      input: parseMessageInput(input.body), ...(input.browserId !== undefined ? { browser_id: input.browserId } : {}), ...(input.idempotencyKey !== undefined ? { idempotency_key: validateIdempotencyKey(input.idempotencyKey) } : {}),
    }))));
    const message = value.message as { sequence: number };
    return { ...value, wait: foregroundWait(this.origin, input.room, message.sequence) } as unknown as PostMessageResponse;
  }

  async getPost(input: GetPostMessageInput): Promise<GetPostMessageResponse> {
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/get-post", {
      input: parseMessageInput(input.body),
      request_id: validateRequestId(input.requestId),
      token: input.token,
    })));
    return value as unknown as GetPostMessageResponse;
  }

  async getPostProbe(input: GetPostProbeInput): Promise<GetPostProbeResponse> {
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/get-post-probe", {
      token: input.token,
    })));
    return value as unknown as GetPostProbeResponse;
  }

  async readPushEnrollment(input: PushEnrollmentInput): Promise<PushEnrollmentResponse> {
    const response = await this.room(input.room).fetch(new Request("https://room/push-subscriptions", {
      headers: { "x-msg-browser-id": input.browserId },
    }));
    return await responseJson(response) as unknown as PushEnrollmentResponse;
  }

  async enrollPush(input: EnrollPushInput): Promise<PushEnrollmentResponse> {
    const response = await this.room(input.room).fetch(jsonRequest("/push-subscriptions", {
      browser_id: input.browserId,
      subscription: input.subscription,
    }));
    return await responseJson(response) as unknown as PushEnrollmentResponse;
  }

  async removePushEnrollment(input: PushEnrollmentInput): Promise<RemovePushEnrollmentResponse> {
    const response = await this.room(input.room).fetch(new Request("https://room/push-subscriptions", {
      headers: { "x-msg-browser-id": input.browserId },
      method: "DELETE",
    }));
    return await responseJson(response) as unknown as RemovePushEnrollmentResponse;
  }

  async manage(input: ManageRoomInput): Promise<ManageRoomResponse> {
    if (!input.action) {
      return responseJson(await this.room(input.room).fetch(new Request(`https://room/manage?token=${encodeURIComponent(input.token)}`, { method: input.method }))) as unknown as ManageRoomResponse;
    }
    const delegatedToken = input.action === "disable" ? undefined : randomCapability(this.random);
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest(`/manage?token=${encodeURIComponent(input.token)}`, {
      action: input.action,
      ...(delegatedToken ? { get_post_token: delegatedToken } : {}),
    })));
    const result = value as unknown as ManageRoomResponse;
    if (delegatedToken && result.get_post_enabled) {
      return {
        ...result,
        get_post_url: `${this.origin}/${encodeURIComponent(input.room)}/post?token=${encodeURIComponent(delegatedToken)}`,
        get_post_url_warning: GET_POST_URL_WARNING,
      };
    }
    return result;
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

  async disableWebhook(input: ManageWebhookInput): Promise<ManageWebhookResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/webhooks/${encodeURIComponent(input.id)}/disable`, { method: "POST" }))) as unknown as ManageWebhookResponse;
  }

  async enableWebhook(input: ManageWebhookInput): Promise<ManageWebhookResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/webhooks/${encodeURIComponent(input.id)}/enable`, { method: "POST" }))) as unknown as ManageWebhookResponse;
  }

  async rotateWebhookSecret(input: ManageWebhookInput): Promise<RotateWebhookSecretResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/webhooks/${encodeURIComponent(input.id)}/rotate-secret`, { method: "POST" }))) as unknown as RotateWebhookSecretResponse;
  }

  async redeliverWebhook(input: RedeliverWebhookInput): Promise<RedeliverWebhookResponse> {
    return responseJson(await this.room(input.room).fetch(new Request(`https://room/webhooks/${encodeURIComponent(input.id)}/deliveries/${encodeURIComponent(input.eventId)}/redeliver`, { method: "POST" }))) as unknown as RedeliverWebhookResponse;
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

const GET_POST_URL_WARNING = "This URL is a delegated GET write capability for one owner-enabled thread token; URL previews can submit the first message. For a ChatGPT Action or connector, configure X-0000-Post-Token API-key authentication and send POST without a token query. Keep the token out of POST request bodies, model-visible parameters, examples, and room content. Reuse Idempotency-Key or request_id only when retrying the same message.";

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

import { ERROR_CODES, isStaleRevisionDetails, isStaleSequenceDetails, ProtocolError } from "./errors";
import { parseCoordinationProposal, parseCoordinationPublish, parseCoordinationRevision } from "./coordination-domain";
import { hashCapability, parseBasedOnSequence, parseMessageInput, randomCapability, validateIdempotencyKey, validateRequestId } from "./room-domain";
import { buildShareMessage, foregroundWait, PROTOCOL_VERSION, stripLegacyAbsoluteExpiry, type CoordinationListInput, type CoordinationOverviewResponse, type CoordinationProposalDetailInput, type CoordinationProposalInput, type CoordinationProposalResponse, type CoordinationProposalRevisionInput, type CoordinationProposalListResponse, type CoordinationPublishInput, type CoordinationPublishResponse, type CoordinationRequestDetailInput, type CoordinationRequestListResponse, type CoordinationRequestResponse, type CreateRoomInput, type CreateRoomResponse, type CreateWebhookInput, type CreateWebhookResponse, type EnrollPushInput, type ExportRoomInput, type GetPostMessageInput, type GetPostMessageResponse, type ListWebhooksInput, type ListWebhooksResponse, type LiveRoomInput, type ManageRoomInput, type ManageRoomResponse, type ManageWebhookInput, type ManageWebhookResponse, type PostMessageInput, type PostMessageResponse, type PushEnrollmentInput, type PushEnrollmentResponse, type ReadMessageInput, type ReadMessageResponse, type ReadRoomInput, type ReadRoomResponse, type RedeliverWebhookInput, type RedeliverWebhookResponse, type RemovePushEnrollmentResponse, type RemoveWebhookInput, type RemoveWebhookResponse, type RotateWebhookSecretResponse, type RoomService } from "./protocol";

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
    const endpoint = new URL("https://room/read");
    endpoint.searchParams.set("after", String(input.after));
    if (input.limit !== undefined) endpoint.searchParams.set("limit", String(input.limit));
    if (input.through !== undefined) endpoint.searchParams.set("through", String(input.through));
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(endpoint))));
    const conversation_url = `${this.origin}/${input.room}`;
    const latest = value.latest_message as number;
    const waitAfter = typeof value.next_after === "number" ? value.next_after : latest;
    return {
      ...value,
      conversation_url,
      share_message: buildShareMessage(conversation_url),
      wait: foregroundWait(this.origin, input.room, waitAfter),
    } as unknown as ReadRoomResponse;
  }

  async readMessage(input: ReadMessageInput): Promise<ReadMessageResponse> {
    const endpoint = `https://room/messages/${encodeURIComponent(input.id)}`;
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(endpoint))));
    return {
      ...value,
      conversation_url: `${this.origin}/${input.room}`,
    } as unknown as ReadMessageResponse;
  }

  async post(input: PostMessageInput): Promise<PostMessageResponse> {
    const basedOnSequence = input.basedOnSequence ?? parseBasedOnSequence(input.body);
    const value = stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(jsonRequest("/messages", {
      input: parseMessageInput(input.body), ...(basedOnSequence === undefined ? {} : { based_on_sequence: basedOnSequence }), ...(input.browserId !== undefined ? { browser_id: input.browserId } : {}), ...(input.idempotencyKey !== undefined ? { idempotency_key: validateIdempotencyKey(input.idempotencyKey) } : {}),
    }))));
    const message = value.message as { sequence: number };
    return { ...value, wait: foregroundWait(this.origin, input.room, message.sequence) } as unknown as PostMessageResponse;
  }

  async getPost(input: GetPostMessageInput): Promise<GetPostMessageResponse> {
    const basedOnSequence = input.basedOnSequence ?? parseBasedOnSequence(input.body);
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/get-post", {
      input: parseMessageInput(input.body),
      ...(basedOnSequence === undefined ? {} : { based_on_sequence: basedOnSequence }),
      request_id: validateRequestId(input.requestId),
      token: input.token,
    })));
    return value as unknown as GetPostMessageResponse;
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
      ...(delegatedToken === undefined ? {} : { get_post_token: delegatedToken }),
    })));
    const result = value as unknown as ManageRoomResponse;
    if (delegatedToken !== undefined && result.get_post_enabled === true) {
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

  async coordinationOverview(input: { readonly room: string }): Promise<CoordinationOverviewResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request("https://room/coordination"))) as unknown as CoordinationOverviewResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationOverviewResponse;
  }

  async listCoordinationProposals(input: CoordinationListInput): Promise<CoordinationProposalListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/proposals", input)))) as unknown as CoordinationProposalListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationProposalListResponse;
  }

  async readCoordinationProposal(input: CoordinationProposalDetailInput): Promise<CoordinationProposalResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(`https://room/coordination/proposals/${encodeURIComponent(input.proposalId)}`))) as unknown as CoordinationProposalResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationProposalResponse;
  }

  async readCoordinationProposalRevision(input: CoordinationProposalDetailInput & { readonly revision: number }): Promise<CoordinationProposalResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(`https://room/coordination/proposals/${encodeURIComponent(input.proposalId)}/revisions/${input.revision}`))) as unknown as CoordinationProposalResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationProposalResponse;
  }

  async submitCoordinationProposal(input: CoordinationProposalInput): Promise<CoordinationProposalResponse> {
    const body = input.body.kind === "json" ? parseCoordinationProposal(input.body.value) : (() => { throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination proposal must be JSON.", 400); })();
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/coordination/proposals", body))) as unknown as CoordinationProposalResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationProposalResponse;
  }

  async submitCoordinationRevision(input: CoordinationProposalRevisionInput): Promise<CoordinationProposalResponse> {
    const body = input.body.kind === "json" ? parseCoordinationRevision(input.body.value) : (() => { throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination revision must be JSON.", 400); })();
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest(`/coordination/proposals/${encodeURIComponent(input.proposalId)}/revisions`, body))) as unknown as CoordinationProposalResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationProposalResponse;
  }

  async listCoordinationRequests(input: CoordinationListInput): Promise<CoordinationRequestListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/requests", input)))) as unknown as CoordinationRequestListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationRequestListResponse;
  }

  async readCoordinationRequest(input: CoordinationRequestDetailInput): Promise<CoordinationRequestResponse> {
    const endpoint = coordinationListUrl(`/coordination/requests/${encodeURIComponent(input.requestId)}`, input);
    const value = await responseJson(await this.room(input.room).fetch(new Request(endpoint))) as unknown as CoordinationRequestResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationRequestResponse;
  }

  async publishCoordinationRequest(input: CoordinationPublishInput): Promise<CoordinationPublishResponse> {
    const body = input.body.kind === "json" ? parseCoordinationPublish(input.body.value) : (() => { throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination publication must be JSON.", 400); })();
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest(`/coordination/publish?token=${encodeURIComponent(input.ownerToken)}`, body))) as unknown as CoordinationPublishResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationPublishResponse;
  }

  private room(capability: string): RoomStub { return this.rooms.getByName(capability); }
}

const GET_POST_URL_WARNING = "This URL is a write capability. URL previews can submit the first message; treat it as a secret, and reuse request_id only when retrying the same message.";

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
  const code = (error?.code as typeof ERROR_CODES[keyof typeof ERROR_CODES]) ?? ERROR_CODES.internal;
  const details = code === ERROR_CODES.staleSequence && isStaleSequenceDetails(error)
    ? { latest_message: error.latest_message, review_after: error.review_after }
    : code === ERROR_CODES.staleRevision && isStaleRevisionDetails(error)
      ? { current_revision: error.current_revision, submitted_base_revision: error.submitted_base_revision }
      : undefined;
  return new ProtocolError(code, error?.message ?? "The room could not complete the request.", response.status, undefined, details);
}

function coordinationListUrl(path: string, input: CoordinationListInput): string {
  const url = new URL(`https://room${path}`);
  if (input.after !== undefined) url.searchParams.set("after", String(input.after));
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
  if (input.through !== undefined) url.searchParams.set("through", String(input.through));
  return url.toString();
}

function hydrateCoordination(value: unknown, origin: string, room: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  const base = `${origin}/${encodeURIComponent(room)}`;
  if ("coordination_cursor" in result || "published_revision" in result) result.conversation_url = base;
  for (const key of ["proposals_url", "requests_url"] as const) {
    if (typeof result[key] === "string" && result[key].startsWith("/")) result[key] = `${base}${result[key]}`;
  }
  for (const key of ["proposal", "request"] as const) {
    const item = result[key];
    if (item && typeof item === "object" && !Array.isArray(item)) result[key] = hydrateCoordinationItem(item as Record<string, unknown>, base);
  }
  for (const key of ["proposals", "pending_proposals", "requests", "published_requests", "revisions"] as const) {
    const items = result[key];
    if (Array.isArray(items)) result[key] = items.map((item) => item && typeof item === "object" && !Array.isArray(item) ? hydrateCoordinationItem(item as Record<string, unknown>, base) : item);
  }
  return result;
}

function hydrateCoordinationItem(item: Record<string, unknown>, base: string): Record<string, unknown> {
  const result = { ...item };
  if (typeof result.detail_url === "string" && result.detail_url.startsWith("/")) result.detail_url = `${base}${result.detail_url}`;
  if (Array.isArray(result.source_messages)) {
    result.source_messages = result.source_messages.map((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return source;
      const hydrated = { ...(source as Record<string, unknown>) };
      if (typeof hydrated.citation_url === "string" && hydrated.citation_url.startsWith("/")) hydrated.citation_url = `${base}${hydrated.citation_url}`;
      return hydrated;
    });
  }
  return result;
}

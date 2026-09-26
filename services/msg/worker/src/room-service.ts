import { ERROR_CODES, isStaleRevisionDetails, isStaleSequenceDetails, ProtocolError } from "./errors";
import { parseCoordinationDispute, parseCoordinationDisputeReview, parseCoordinationProposal, parseCoordinationPublish, parseCoordinationRevision } from "./coordination-domain";
import { hashCapability, parseBasedOnSequence, parseMessageInput, parseRetentionExtension, randomCapability, validateIdempotencyKey, validateRequestId } from "./room-domain";
import { buildShareMessage, foregroundWait, PROTOCOL_VERSION, stripLegacyAbsoluteExpiry, type CoordinationAcceptedRecordInput, type CoordinationAcceptedRecordResponse, type CoordinationCorrectionDetailInput, type CoordinationCorrectionListInput, type CoordinationCorrectionListResponse, type CoordinationCorrectionResponse, type CoordinationDecisionDetailInput, type CoordinationDecisionListInput, type CoordinationDecisionListResponse, type CoordinationDecisionResponse, type CoordinationDisputeDetailInput, type CoordinationDisputeInput, type CoordinationDisputeListInput, type CoordinationDisputeListResponse, type CoordinationDisputeResponse, type CoordinationDisputeReviewInput, type CoordinationDisputeReviewResponse, type CoordinationListInput, type CoordinationOverviewResponse, type CoordinationPanelDetailInput, type CoordinationPanelHistoryInput, type CoordinationPanelHistoryResponse, type CoordinationPanelResponse, type CoordinationProposalDetailInput, type CoordinationProposalInput, type CoordinationProposalResponse, type CoordinationProposalRevisionInput, type CoordinationProposalListResponse, type CoordinationPublishInput, type CoordinationPublishResponse, type CoordinationPublicationInput, type CoordinationPublicationResponse, type CoordinationRequestDetailInput, type CoordinationRequestListResponse, type CoordinationRequestResponse, type CoordinationSupersessionListInput, type CoordinationSupersessionListResponse, type CreateRoomInput, type CreateRoomResponse, type CreateWebhookInput, type CreateWebhookResponse, type EnrollPushInput, type ExportRoomInput, type ExtendRetentionInput, type GetPostMessageInput, type GetPostMessageResponse, type ListWebhooksInput, type ListWebhooksResponse, type LiveRoomInput, type ManageRoomInput, type ManageRoomResponse, type ManageWebhookInput, type ManageWebhookResponse, type PostMessageInput, type PostMessageResponse, type PushEnrollmentInput, type PushEnrollmentResponse, type ReadMessageInput, type ReadMessageResponse, type ReadRoomInput, type ReadRoomResponse, type RedeliverWebhookInput, type RedeliverWebhookResponse, type RemovePushEnrollmentResponse, type RemoveWebhookInput, type RemoveWebhookResponse, type RetentionExtensionResponse, type RotateWebhookSecretResponse, type RoomService } from "./protocol";

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
      room: { id: room, created_at: value.created_at as string, expires_at: value.expires_at as string, protocol_version: PROTOCOL_VERSION, ...(value.retention === undefined || value.retention === null ? {} : { retention: value.retention as CreateRoomResponse["retention"] }) },
      conversation_url,
      share_message: buildShareMessage(conversation_url),
      manage_url,
      latest_message: 1,
      expires_at: value.expires_at as string,
      ...(value.retention === undefined || value.retention === null ? {} : { retention: value.retention as CreateRoomResponse["retention"] }),
      ...(typeof value.name_password === "string" ? { name_password: value.name_password, name_password_notice: typeof value.name_password_notice === "string" ? value.name_password_notice : undefined } : {}),
      wait: foregroundWait(this.origin, room, 1),
    };
  }

  async read(input: ReadRoomInput): Promise<ReadRoomResponse> {
    const endpoint = new URL("https://room/read");
    endpoint.searchParams.set("after", String(input.after));
    if (input.limit !== undefined) endpoint.searchParams.set("limit", String(input.limit));
    if (input.through !== undefined) endpoint.searchParams.set("through", String(input.through));
    const value = hydrateCoordination(stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(endpoint)))), this.origin, input.room) as Record<string, unknown>;
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
    const value = hydrateCoordination(stripLegacyAbsoluteExpiry(await responseJson(await this.room(input.room).fetch(new Request(endpoint)))), this.origin, input.room) as Record<string, unknown>;
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

  async extendRetention(input: ExtendRetentionInput): Promise<RetentionExtensionResponse> {
    if (input.body.kind !== "json") throw new ProtocolError(ERROR_CODES.invalidBody, "The retention extension must be JSON.", 400);
    const body = parseRetentionExtension(input.body.value);
    return responseJson(await this.room(input.room).fetch(jsonRequest(`/manage/retention?token=${encodeURIComponent(input.token)}`, {
      client_retry_id: body.client_retry_id,
      expires_at: body.expires_at,
    }))) as unknown as RetentionExtensionResponse;
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
    const suffix = input.format === "json" ? "json" : "md";
    return responsePassthrough(await this.room(input.room).fetch(new Request(`https://room/export.${suffix}`, {
      headers: {
        "x-msg-export-origin": this.origin,
        "x-msg-export-room": encodeURIComponent(input.room),
      },
    })));
  }

  async coordinationOverview(input: { readonly room: string }): Promise<CoordinationOverviewResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request("https://room/coordination"))) as unknown as CoordinationOverviewResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationOverviewResponse;
  }

  async listCoordinationDecisions(input: CoordinationDecisionListInput): Promise<CoordinationDecisionListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/decisions", input)))) as unknown as CoordinationDecisionListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDecisionListResponse;
  }

  async readCoordinationDecision(input: CoordinationDecisionDetailInput): Promise<CoordinationDecisionResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl(`/coordination/decisions/${encodeURIComponent(input.decisionId)}`, input)))) as unknown as CoordinationDecisionResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDecisionResponse;
  }

  async readCoordinationAcceptedRecord(input: CoordinationAcceptedRecordInput): Promise<CoordinationAcceptedRecordResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(`https://room/coordination/decisions/${encodeURIComponent(input.decisionId)}/records/${encodeURIComponent(input.acceptedRecordId)}`))) as unknown as CoordinationAcceptedRecordResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationAcceptedRecordResponse;
  }

  async readCoordinationPublication(input: CoordinationPublicationInput): Promise<CoordinationPublicationResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(`https://room/coordination/publications/${input.publishedRevision}`))) as unknown as CoordinationPublicationResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationPublicationResponse;
  }

  async listCoordinationCorrections(input: CoordinationCorrectionListInput): Promise<CoordinationCorrectionListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/corrections", input)))) as unknown as CoordinationCorrectionListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationCorrectionListResponse;
  }

  async readCoordinationCorrection(input: CoordinationCorrectionDetailInput): Promise<CoordinationCorrectionResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(`https://room/coordination/corrections/${encodeURIComponent(input.correctionId)}`))) as unknown as CoordinationCorrectionResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationCorrectionResponse;
  }

  async submitCoordinationDispute(input: CoordinationDisputeInput): Promise<CoordinationDisputeResponse> {
    const body = input.body.kind === "json" ? parseCoordinationDispute(input.body.value) : (() => { throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination dispute must be JSON.", 400); })();
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest("/coordination/disputes", body))) as unknown as CoordinationDisputeResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDisputeResponse;
  }

  async listCoordinationDisputes(input: CoordinationDisputeListInput): Promise<CoordinationDisputeListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/disputes", input)))) as unknown as CoordinationDisputeListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDisputeListResponse;
  }

  async listCoordinationSupersessions(input: CoordinationSupersessionListInput): Promise<CoordinationSupersessionListResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/supersessions", input)))) as unknown as CoordinationSupersessionListResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationSupersessionListResponse;
  }

  async readCoordinationDispute(input: CoordinationDisputeDetailInput): Promise<CoordinationDisputeResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl(`/coordination/disputes/${encodeURIComponent(input.reportId)}`, input)))) as unknown as CoordinationDisputeResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDisputeResponse;
  }

  async reviewCoordinationDispute(input: CoordinationDisputeReviewInput): Promise<CoordinationDisputeReviewResponse> {
    const body = input.body.kind === "json" ? parseCoordinationDisputeReview(input.body.value) : (() => { throw new ProtocolError(ERROR_CODES.invalidBody, "The coordination dispute review must be JSON.", 400); })();
    const value = await responseJson(await this.room(input.room).fetch(jsonRequest(`/coordination/disputes/${encodeURIComponent(input.reportId)}/review?token=${encodeURIComponent(input.ownerToken)}`, body))) as unknown as CoordinationDisputeReviewResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationDisputeReviewResponse;
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

  async readCoordinationPanel(input: CoordinationPanelDetailInput): Promise<CoordinationPanelResponse> {
    const endpoint = new URL("https://room/coordination/panel");
    if (input.revision !== undefined) endpoint.searchParams.set("revision", String(input.revision));
    const value = await responseJson(await this.room(input.room).fetch(new Request(endpoint))) as unknown as CoordinationPanelResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationPanelResponse;
  }

  async listCoordinationPanelHistory(input: CoordinationPanelHistoryInput): Promise<CoordinationPanelHistoryResponse> {
    const value = await responseJson(await this.room(input.room).fetch(new Request(coordinationListUrl("/coordination/panel/history", input)))) as unknown as CoordinationPanelHistoryResponse;
    return hydrateCoordination(value, this.origin, input.room) as CoordinationPanelHistoryResponse;
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

function coordinationListUrl(path: string, input: { readonly acceptedRecordId?: string; readonly after?: number; readonly kind?: string; readonly limit?: number; readonly owner_label?: string; readonly predecessorAcceptedRecordId?: string; readonly status?: string; readonly successorDecisionId?: string; readonly targetClaimPath?: readonly (string | number)[]; readonly targetMessageId?: string; readonly targetPublishedRevision?: number; readonly targetType?: string; readonly through?: number }): string {
  const url = new URL(`https://room${path}`);
  if (input.acceptedRecordId !== undefined) url.searchParams.set("accepted_record_id", input.acceptedRecordId);
  if (input.after !== undefined) url.searchParams.set("after", String(input.after));
  if (input.kind !== undefined) url.searchParams.set("kind", input.kind);
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
  if (input.owner_label !== undefined) url.searchParams.set("owner_label", input.owner_label);
  if (input.predecessorAcceptedRecordId !== undefined) url.searchParams.set("predecessor_accepted_record_id", input.predecessorAcceptedRecordId);
  if (input.status !== undefined) url.searchParams.set("status", input.status);
  if (input.successorDecisionId !== undefined) url.searchParams.set("successor_decision_id", input.successorDecisionId);
  if (input.targetClaimPath !== undefined) url.searchParams.set("target_claim_path", JSON.stringify(input.targetClaimPath));
  if (input.targetMessageId !== undefined) url.searchParams.set("target_message_id", input.targetMessageId);
  if (input.targetPublishedRevision !== undefined) url.searchParams.set("target_published_revision", String(input.targetPublishedRevision));
  if (input.targetType !== undefined) url.searchParams.set("target_type", input.targetType);
  if (input.through !== undefined) url.searchParams.set("through", String(input.through));
  return url.toString();
}

const COORDINATION_URL_KEYS = [
  "accepted_record_url",
  "citation_url",
  "corrections_url",
  "decision_url",
  "detail_url",
  "panel_history_url",
  "panel_url",
  "predecessor_url",
  "predecessors_url",
  "proposal_url",
  "proposals_url",
  "published_url",
  "reports_url",
  "request_url",
  "requests_url",
  "source_url",
  "successor_url",
  "successors_url",
  "supersessions_url",
  "target_url",
] as const;

const COORDINATION_OBJECT_KEYS = [
  "accepted_record",
  "coordination_overview",
  "correction",
  "current_annotations",
  "decision",
  "dispute",
  "latest_review",
  "panel",
  "position",
  "publication",
  "proposal",
  "report",
  "request",
  "review",
  "source_message",
  "supersession",
] as const;

const COORDINATION_ARRAY_KEYS = [
  "approvals",
  "correction_summaries",
  "corrections",
  "decision_summaries",
  "decisions",
  "disputes",
  "events",
  "history",
  "pending_proposals",
  "positions",
  "predecessor_links",
  "proposals",
  "published_requests",
  "reports_preview",
  "requests",
  "revisions",
  "reviews",
  "source_messages",
  "successor_links",
  "supersessions",
] as const;

function hydrateCoordination(value: unknown, origin: string, room: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const base = `${origin}/${encodeURIComponent(room)}`;
  const result = hydrateCoordinationRecord(value as Record<string, unknown>, base);
  if ("coordination_cursor" in result || "published_revision" in result) result.conversation_url = base;
  return result;
}

function hydrateCoordinationRecord(item: Record<string, unknown>, base: string): Record<string, unknown> {
  const result = { ...item };
  for (const key of COORDINATION_URL_KEYS) {
    if (typeof result[key] === "string" && result[key].startsWith("/")) result[key] = `${base}${result[key]}`;
  }
  for (const key of COORDINATION_OBJECT_KEYS) {
    const nested = result[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) result[key] = hydrateCoordinationRecord(nested as Record<string, unknown>, base);
  }
  for (const key of COORDINATION_ARRAY_KEYS) {
    const nested = result[key];
    if (Array.isArray(nested)) result[key] = nested.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      ? hydrateCoordinationRecord(entry as Record<string, unknown>, base)
      : entry);
  }
  return result;
}

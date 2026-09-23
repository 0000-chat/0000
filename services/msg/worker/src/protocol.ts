export const PROTOCOL_VERSION = 1 as const;

/** Durable Object read budget used by the stateless MCP endpoint. */
export const MCP_READ_BYTE_BUDGET_BYTES = 128 * 1024;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type Representation = "html" | "json" | "markdown";

export interface RoomMetadata {
  readonly id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface Message {
  readonly id: string;
  readonly created_at: string;
  readonly content: string;
}

export type RequestBody =
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "raw"; readonly value: string };

export interface CreateRoomInput {
  readonly body: RequestBody;
  readonly plan?: { readonly management: string; readonly room: string };
}

export interface CreateRoomResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly room: RoomMetadata;
  readonly conversation_url: string;
  readonly share_message: string;
  readonly manage_url?: string;
  readonly latest_message?: number;
  readonly expires_at?: string;
  readonly wait: WaitMetadata;
}

export interface WaitMetadata {
  readonly after: number;
  readonly command: string;
  readonly requires_user_consent: true;
}

/** Validates and normalizes a public room URL without accepting management capabilities. */
export function publicConversationUrl(value: string): string {
  let conversation: URL;
  try {
    conversation = new URL(value);
  } catch {
    throw new Error("The public conversation URL is invalid.");
  }
  if (
    conversation.protocol !== "https:" ||
    conversation.username ||
    conversation.password ||
    conversation.search ||
    conversation.hash ||
    !/^\/[^/]+$/.test(conversation.pathname)
  ) {
    throw new Error("The public conversation URL is invalid.");
  }
  return conversation.toString();
}

export function buildShareMessage(conversationUrl: string): string {
  const url = publicConversationUrl(conversationUrl);
  return [
    "Join my conversation:",
    url,
    "",
    "If you are using an AI agent, copy this message to it:",
    "",
    "```",
    "Do not open or automate the web page.",
    `Run \`npx --yes @0000chat/msg@latest join ${url}\` and follow the instructions it returns.`,
    "```",
  ].join("\n");
}

/** Builds a wait command from only the canonical public room URL and its latest sequence. */
export function foregroundWait(origin: string, room: string, after: number): WaitMetadata {
  const conversation = new URL(new URL(origin).origin);
  conversation.pathname = `/${encodeURIComponent(room)}`;
  return foregroundWaitForConversation(conversation.toString(), after);
}

/** Builds a wait command for an existing canonical public conversation URL. */
export function foregroundWaitForConversation(conversationUrl: string, after: number): WaitMetadata {
  const canonicalUrl = publicConversationUrl(conversationUrl);
  return {
    after,
    command: `npx --yes @0000chat/msg@latest wait ${shellQuote(canonicalUrl)} --after ${after}`,
    requires_user_consent: true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface RoomService {
  create(input: CreateRoomInput): Promise<CreateRoomResponse>;
  mcpPost?(input: McpPostMessageInput): Promise<McpPostMessageResponse>;
  roomStatus?(input: RoomStatusInput): Promise<RoomStatusResponse>;
  getPost?(input: GetPostMessageInput): Promise<GetPostMessageResponse>;
  getPostProbe?(input: GetPostProbeInput): Promise<GetPostProbeResponse>;
  read?(input: ReadRoomInput): Promise<ReadRoomResponse>;
  post?(input: PostMessageInput): Promise<PostMessageResponse>;
  manage?(input: ManageRoomInput): Promise<ManageRoomResponse>;
  createWebhook?(input: CreateWebhookInput): Promise<CreateWebhookResponse>;
  listWebhooks?(input: ListWebhooksInput): Promise<ListWebhooksResponse>;
  removeWebhook?(input: RemoveWebhookInput): Promise<RemoveWebhookResponse>;
  disableWebhook?(input: ManageWebhookInput): Promise<ManageWebhookResponse>;
  enableWebhook?(input: ManageWebhookInput): Promise<ManageWebhookResponse>;
  rotateWebhookSecret?(input: ManageWebhookInput): Promise<RotateWebhookSecretResponse>;
  redeliverWebhook?(input: RedeliverWebhookInput): Promise<RedeliverWebhookResponse>;
  readPushEnrollment?(input: PushEnrollmentInput): Promise<PushEnrollmentResponse>;
  enrollPush?(input: EnrollPushInput): Promise<PushEnrollmentResponse>;
  removePushEnrollment?(input: PushEnrollmentInput): Promise<RemovePushEnrollmentResponse>;
  operatorDelete?(room: string): Promise<void>;
  live?(input: LiveRoomInput): Promise<Response>;
  exportRoom?(input: ExportRoomInput): Promise<Response>;
}

export interface ReadRoomInput {
  readonly after: number;
  /** Optional bounded number of messages to fetch from the room store. */
  readonly limit?: number;
  /** Optional stored-byte budget for bounded consumers such as MCP. */
  readonly max_bytes?: number;
  readonly room: string;
}

export interface RoomMessage extends Message {
  readonly author?: string;
  readonly byte_count?: number;
  readonly client?: string;
  readonly client_message_id?: string;
  readonly display_name?: string;
  readonly identity_verified?: false;
  readonly reply_to?: string;
  readonly semantic_type?: string;
  readonly sequence: number;
}

export interface RoomReadResult {
  readonly access_warning?: string;
  readonly conversation_url: string;
  readonly expires_at: string;
  readonly has_more?: boolean;
  readonly latest_message: number;
  readonly messages: readonly RoomMessage[];
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly share_message: string;
  readonly wait: WaitMetadata;
}

export type ReadRoomResponse = RoomReadResult;

export interface PostMessageInput {
  readonly body: RequestBody;
  readonly browserId?: string;
  readonly idempotencyKey?: string;
  readonly room: string;
}

export interface PushSubscriptionInput {
  readonly auth: string;
  readonly endpoint: string;
  readonly p256dh: string;
}

export interface PushEnrollmentInput {
  readonly browserId: string;
  readonly room: string;
}

export interface EnrollPushInput extends PushEnrollmentInput {
  readonly subscription: PushSubscriptionInput;
}

export interface PushEnrollmentResponse {
  readonly enrolled: boolean;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface RemovePushEnrollmentResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly removed: boolean;
}

export interface PostMessageResponse {
  readonly expires_at: string;
  readonly message: RoomMessage;
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly wait: WaitMetadata;
}

/** MCP writes use the canonical public room URL and the room's owner-controlled setting. */
export interface McpPostMessageInput {
  readonly body: RequestBody;
  readonly room: string;
}

export interface McpPostMessageResponse {
  readonly accepted: true;
  readonly client_message_id: string;
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly replayed: boolean;
  readonly request_id: string;
  readonly sequence: number;
}

export interface RoomStatusInput {
  readonly room: string;
}

export interface RoomStatusResponse {
  readonly active: boolean;
  readonly agent_posting_enabled: boolean;
  readonly expires_at: string;
  readonly latest_message: number;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface GetPostMessageInput {
  readonly body: RequestBody;
  readonly requestId: string;
  readonly room: string;
  readonly token: string;
}

export interface GetPostMessageResponse {
  readonly accepted: true;
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly replayed: boolean;
  readonly request_id: string;
  readonly sequence: number;
}

export interface GetPostProbeInput {
  readonly room: string;
  readonly token: string;
}

export interface GetPostProbeResponse {
  readonly active: true;
  readonly get_post_enabled: true;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface ManageRoomInput {
  readonly action?: "disable" | "enable" | "rotate" | "disable_mcp" | "enable_mcp";
  readonly method: "DELETE" | "GET" | "POST";
  readonly room: string;
  readonly token: string;
}

export interface ManageRoomResponse {
  readonly agent_posting_enabled?: boolean;
  readonly deleted?: boolean;
  readonly expires_at?: string;
  readonly get_post_enabled?: boolean;
  readonly get_post_url?: string;
  readonly get_post_url_warning?: string;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface CreateWebhookInput {
  readonly room: string;
  readonly url: string;
}

export interface ListWebhooksInput {
  readonly room: string;
}

export interface RemoveWebhookInput {
  readonly id: string;
  readonly room: string;
}

export interface ManageWebhookInput {
  readonly id: string;
  readonly room: string;
}

export interface RedeliverWebhookInput extends ManageWebhookInput {
  readonly eventId: string;
}

export interface WebhookDeliveryMetadata {
  readonly attempts: readonly WebhookAttemptMetadata[];
  readonly attempt_count: number;
  readonly attempted_at: string | null;
  readonly cancelled_at: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly event_id: string;
  readonly failure_category: string | null;
  readonly message_id: string;
  readonly message_sequence: number;
  readonly next_attempt_at: string | null;
  readonly retry_expires_at: string;
  readonly status: "cancelled" | "delivered" | "failed" | "pending" | "retrying" | "sending";
}

export interface WebhookAttemptMetadata {
  readonly attempt_number: number;
  readonly attempted_at: string;
  readonly completed_at: string | null;
  readonly failure_category: string | null;
  readonly status: "delivered" | "failed" | "sending";
}

export interface WebhookSummary {
  readonly created_at: string;
  readonly deliveries: readonly WebhookDeliveryMetadata[];
  readonly disabled_at: string | null;
  readonly failure_started_at: string | null;
  readonly id: string;
  readonly last_failure_at: string | null;
  readonly last_success_at: string | null;
  readonly recovered_at: string | null;
  readonly status: "active" | "disabled";
  readonly url: string;
}

export interface CreateWebhookResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly secret: string;
  readonly webhook: WebhookSummary;
}

export interface ListWebhooksResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly webhooks: readonly WebhookSummary[];
}

export interface RemoveWebhookResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly removed: true;
}

export interface ManageWebhookResponse {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly webhook: WebhookSummary;
}

export interface RotateWebhookSecretResponse extends ManageWebhookResponse {
  readonly secret: string;
}

export interface RedeliverWebhookResponse {
  readonly delivery: WebhookDeliveryMetadata;
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly result: "already_queued" | "queued";
}

export interface LiveRoomInput {
  readonly after: number;
  readonly room: string;
}

export interface ExportRoomInput {
  readonly format: "json" | "markdown";
  readonly room: string;
}

/** Removes the legacy absolute-expiry field from replayed or rolling-deploy data. */
export function stripLegacyAbsoluteExpiry<T extends object>(value: T): Omit<T, "absolute_expires_at"> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.absolute_expires_at;
  return copy as Omit<T, "absolute_expires_at">;
}

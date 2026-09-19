export const PROTOCOL_VERSION = 1 as const;

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
  readonly ownerGuestId?: string;
  readonly plan?: { readonly management: string; readonly room: string };
}

export type RoomAccessSource = "owner" | "public" | "management";
export interface RoomAccessContext {
  readonly credential?: string;
  readonly guestId: string;
  readonly grantId?: string;
  readonly source: RoomAccessSource;
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
  read?(input: ReadRoomInput): Promise<ReadRoomResponse>;
  post?(input: PostMessageInput): Promise<PostMessageResponse>;
  manage?(input: ManageRoomInput): Promise<ManageRoomResponse>;
  operatorDelete?(room: string): Promise<void>;
  live?(input: LiveRoomInput): Promise<Response>;
  exportRoom?(input: ExportRoomInput): Promise<Response>;
  proveLink?(input: { readonly room: string; readonly source: RoomAccessSource; readonly token?: string }): Promise<{ readonly source: RoomAccessSource; readonly storedOwnerId?: string } | null>;
  recordGrant?(input: { readonly room: string; readonly guestId: string; readonly source: RoomAccessSource; readonly capabilities: readonly string[] }): Promise<void>;
  checkGrant?(input: { readonly room: string; readonly guestId: string; readonly source: RoomAccessSource; readonly action: "read" | "write" | "manage" }): Promise<boolean>;
}

export interface ReadRoomInput {
  readonly after: number;
  readonly room: string;
  readonly auth?: RoomAccessContext;
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
  readonly latest_message: number;
  readonly messages: readonly RoomMessage[];
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly share_message: string;
  readonly wait: WaitMetadata;
}

export type ReadRoomResponse = RoomReadResult;

export interface PostMessageInput {
  readonly body: RequestBody;
  readonly idempotencyKey?: string;
  readonly room: string;
  readonly auth?: RoomAccessContext;
}

export interface PostMessageResponse {
  readonly expires_at: string;
  readonly message: RoomMessage;
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly wait: WaitMetadata;
}

export interface ManageRoomInput {
  readonly method: "DELETE" | "GET";
  readonly room: string;
  readonly token: string;
  readonly auth?: RoomAccessContext;
}

export interface ManageRoomResponse {
  readonly deleted?: boolean;
  readonly expires_at?: string;
  readonly protocol_version: typeof PROTOCOL_VERSION;
}

export interface LiveRoomInput {
  readonly after: number;
  readonly room: string;
  readonly auth?: RoomAccessContext;
}

export interface ExportRoomInput {
  readonly format: "json" | "markdown";
  readonly room: string;
  readonly auth?: RoomAccessContext;
}

/** Removes the legacy absolute-expiry field from replayed or rolling-deploy data. */
export function stripLegacyAbsoluteExpiry<T extends object>(value: T): Omit<T, "absolute_expires_at"> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.absolute_expires_at;
  return copy as Omit<T, "absolute_expires_at">;
}

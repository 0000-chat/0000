import { validateConversationUrl } from "./wait.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 1_000] as const;

export interface PostCommand {
  readonly author: string;
  readonly clientMessageId?: string;
  readonly content?: string;
  readonly conversationUrl: string;
}

export interface PostOptions extends PostCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly serviceOrigin?: string;
  readonly generatedClientMessageId: () => string;
  readonly signal?: AbortSignal;
  readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly status?: (text: string) => void;
}

export interface PostReceipt {
  readonly client_message_id: string;
  readonly conversation_url: string;
  readonly message_sequence: number;
  readonly replayed: boolean;
  readonly wait: {
    readonly after: number;
    readonly command: string;
    readonly requires_user_consent: true;
  };
}

export class PostSignalError extends Error {
  constructor() { super("The msg post was interrupted."); }
}

export function parsePostCommand(args: readonly string[], serviceOrigin?: string): PostCommand {
  if (args[0] !== "post" || args.length < 4) throw new Error("Usage: msg post <conversation-url> --author <author> [--content <content>] [--client-message-id <id>]");
  const conversationUrl = validateConversationUrl(args[1] ?? "", serviceOrigin);
  const values: Partial<Record<"--author" | "--content" | "--client-message-id", string>> = {};
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--author" && flag !== "--content" && flag !== "--client-message-id") throw new Error(`Unknown post option: ${flag ?? ""}.`);
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    if (values[flag] !== undefined) throw new Error(`${flag} may be provided only once.`);
    values[flag] = value;
  }
  const author = values["--author"];
  if (author === undefined) throw new Error("--author is required.");
  validateNonempty(author, "--author");
  const content = values["--content"];
  if (content !== undefined) validateNonempty(content, "--content");
  const clientMessageId = values["--client-message-id"];
  if (clientMessageId !== undefined) validateClientMessageId(clientMessageId);
  return { author, ...(clientMessageId === undefined ? {} : { clientMessageId }), ...(content === undefined ? {} : { content }), conversationUrl };
}

export async function postMessage(options: PostOptions): Promise<PostReceipt> {
  const conversationUrl = validateConversationUrl(options.conversationUrl, options.serviceOrigin);
  validateNonempty(options.author, "author");
  if (options.content === undefined) throw new Error("The msg post content is required.");
  validateNonempty(options.content, "content");
  const clientMessageId = options.clientMessageId ?? options.generatedClientMessageId();
  validateClientMessageId(clientMessageId);
  const requestBody = JSON.stringify({ author: options.author, content: options.content, client_message_id: clientMessageId });

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfAborted(options.signal);
    let response: Response;
    try {
      response = await options.fetch(conversationUrl, {
        body: requestBody,
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof PostSignalError || options.signal?.aborted) throw new PostSignalError();
      if (attempt === RETRY_DELAYS_MS.length) throw error instanceof Error ? error : new Error("The msg post request failed.");
      await retryAfterDelay(attempt, options);
      continue;
    }
    if (response.ok) {
      throwIfAborted(options.signal);
      return receiptFromResponse(await responseJson(response, options.signal), conversationUrl, clientMessageId);
    }
    await cancelResponseBody(response, options.signal);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === RETRY_DELAYS_MS.length) throw new Error(`The msg service returned HTTP ${response.status}.`);
    await retryAfterDelay(attempt, options);
  }
  throw new Error("The msg post request failed.");
}

async function retryAfterDelay(attempt: number, options: PostOptions): Promise<void> {
  const delay = RETRY_DELAYS_MS[attempt];
  options.status?.(`Retrying post in ${delay}ms.`);
  try {
    await options.sleep(delay, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw new PostSignalError();
    throw error;
  }
  throwIfAborted(options.signal);
}

async function responseJson(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    const value = await response.json();
    throwIfAborted(signal);
    return value;
  } catch (error) {
    if (signal?.aborted) throw new PostSignalError();
    throw error;
  }
}

async function cancelResponseBody(response: Response, signal: AbortSignal | undefined): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The HTTP status remains the result when its unused body cannot be cancelled.
  }
  throwIfAborted(signal);
}

function receiptFromResponse(value: unknown, conversationUrl: string, clientMessageId: string): PostReceipt {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.wait) || !isPositiveSafeInteger(value.message.sequence) || typeof value.replayed !== "boolean" || !isPositiveSafeInteger(value.wait.after) || value.wait.after !== value.message.sequence || value.wait.requires_user_consent !== true) {
    throw new Error("The msg service returned an invalid post receipt. Read the conversation before deciding whether to retry.");
  }
  return {
    client_message_id: clientMessageId,
    conversation_url: conversationUrl,
    message_sequence: value.message.sequence,
    replayed: value.replayed,
    wait: foregroundWait(conversationUrl, value.wait.after),
  };
}

function foregroundWait(conversationUrl: string, after: number): PostReceipt["wait"] {
  return {
    after,
    command: `npx --yes @0000chat/msg@latest wait ${shellQuote(conversationUrl)} --after ${after}`,
    requires_user_consent: true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateNonempty(value: string, field: string): void {
  if (!value) throw new Error(`${field} must not be empty.`);
}

function validateClientMessageId(value: string): void {
  validateNonempty(value, "--client-message-id");
  if (Array.from(value).length > 128) throw new Error("--client-message-id must be at most 128 characters.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PostSignalError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

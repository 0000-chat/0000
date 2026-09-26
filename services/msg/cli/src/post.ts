import { validateConversationUrl } from "./wait.js";

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 1_000] as const;

export interface PostCommand {
  readonly author: string;
  readonly basedOnSequence?: number;
  readonly clientMessageId?: string;
  readonly content?: string;
  readonly conversationUrl: string;
  readonly displayName?: string;
  readonly namePassword?: string;
}

export interface PostOptions extends PostCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly generatedClientMessageId: () => string;
  readonly signal?: AbortSignal;
  readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly status?: (text: string) => void;
}

export interface PostReceipt {
  readonly client_message_id: string;
  readonly conversation_url: string;
  readonly message: {
    readonly created_at: string;
    readonly id: string;
    readonly sequence: number;
  };
  readonly message_sequence: number;
  /** Returned only when this post created a name claim with a generated password. */
  readonly name_password?: string;
  /** Returned alongside a generated name password; never returned for caller-supplied passwords. */
  readonly name_password_notice?: string;
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

export function parsePostCommand(args: readonly string[]): PostCommand {
  if (args[0] !== "post" || args.length < 4) throw new Error(postUsage());
  const conversationUrl = validateConversationUrl(args[1] ?? "");
  const values: Partial<Record<"--author" | "--based-on-sequence" | "--content" | "--client-message-id" | "--display-name" | "--name-password", string>> = {};
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--author" && flag !== "--based-on-sequence" && flag !== "--content" && flag !== "--client-message-id" && flag !== "--display-name" && flag !== "--name-password") throw new Error(`Unknown post option: ${flag ?? ""}.`);
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    if (values[flag] !== undefined) throw new Error(`${flag} may be provided only once.`);
    values[flag] = value;
  }
  const author = values["--author"];
  if (author === undefined) throw new Error("--author is required.");
  validateNonempty(author, "--author");
  const displayName = values["--display-name"];
  if (displayName !== undefined) validateNonempty(displayName, "--display-name");
  const namePassword = values["--name-password"];
  if (namePassword !== undefined) validateNonempty(namePassword, "--name-password");
  const content = values["--content"];
  if (content !== undefined) validateNonempty(content, "--content");
  const clientMessageId = values["--client-message-id"];
  if (clientMessageId !== undefined) validateClientMessageId(clientMessageId);
  const basedOnSequence = values["--based-on-sequence"] === undefined ? undefined : parseBasedOnSequence(values["--based-on-sequence"]!);
  return {
    author,
    ...(basedOnSequence === undefined ? {} : { basedOnSequence }),
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    ...(content === undefined ? {} : { content }),
    conversationUrl,
    ...(displayName === undefined ? {} : { displayName }),
    ...(namePassword === undefined ? {} : { namePassword }),
  };
}

export async function postMessage(options: PostOptions): Promise<PostReceipt> {
  const conversationUrl = validateConversationUrl(options.conversationUrl);
  validateNonempty(options.author, "author");
  if (options.displayName !== undefined) validateNonempty(options.displayName, "display_name");
  if (options.namePassword !== undefined) validateNonempty(options.namePassword, "name_password");
  if (options.content === undefined) throw new Error("The msg post content is required.");
  validateNonempty(options.content, "content");
  const clientMessageId = options.clientMessageId ?? options.generatedClientMessageId();
  validateClientMessageId(clientMessageId);
  if (options.basedOnSequence !== undefined && (!Number.isSafeInteger(options.basedOnSequence) || options.basedOnSequence < 0)) {
    throw new Error("--based-on-sequence must be a nonnegative safe integer.");
  }
  const requestBody = JSON.stringify({
    author: options.author,
    ...(options.basedOnSequence === undefined ? {} : { based_on_sequence: options.basedOnSequence }),
    client_message_id: clientMessageId,
    content: options.content,
    ...(options.displayName === undefined ? {} : { display_name: options.displayName }),
    ...(options.namePassword === undefined ? {} : { name_password: options.namePassword }),
  });

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
      try {
        throwIfAborted(options.signal);
        const value = await responseJson(response, options.signal);
        return receiptFromResponse(value, conversationUrl, clientMessageId, options.status);
      } catch (error) {
        if (error instanceof PostSignalError) throw error;
        if (error instanceof InvalidPostReceiptError) throw error;
        if (options.signal?.aborted) throw new PostSignalError();
        await cancelResponseBody(response, options.signal);
        if (attempt === RETRY_DELAYS_MS.length) throw error instanceof Error ? error : new Error("The msg post response could not be read.");
        await retryAfterDelay(attempt, options);
        continue;
      }
    }
    if (response.status === 409 && !options.signal?.aborted) {
      const staleError = await readStalePostError(response, conversationUrl, options.basedOnSequence, options.signal);
      if (staleError !== undefined) throw staleError;
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
    if (error instanceof SyntaxError) throw new InvalidPostReceiptError();
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

class InvalidPostReceiptError extends Error {
  constructor() { super("The msg service returned an invalid post receipt. Read the conversation before deciding whether to retry."); }
}

function receiptFromResponse(value: unknown, conversationUrl: string, clientMessageId: string, status?: (text: string) => void): PostReceipt {
  const namePassword = isRecord(value) ? value.name_password : undefined;
  const rawNamePasswordNotice = isRecord(value) ? value.name_password_notice : undefined;
  const namePasswordNotice = typeof rawNamePasswordNotice === "string" && rawNamePasswordNotice.length > 0 ? rawNamePasswordNotice : undefined;
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.wait)
    || typeof value.message.id !== "string" || !value.message.id
    || typeof value.message.created_at !== "string" || !Number.isFinite(Date.parse(value.message.created_at))
    || !isPositiveSafeInteger(value.message.sequence)
    || typeof value.message.client_message_id !== "undefined" && value.message.client_message_id !== clientMessageId
    || namePassword !== undefined && !isGeneratedNamePassword(namePassword)
    || rawNamePasswordNotice !== undefined && (namePassword === undefined || namePasswordNotice === undefined)
    || namePassword !== undefined && (typeof namePasswordNotice !== "string" || !namePasswordNotice)
    || typeof value.replayed !== "boolean"
    || !isPositiveSafeInteger(value.wait.after) || value.wait.after !== value.message.sequence
    || value.wait.requires_user_consent !== true) {
    throw new InvalidPostReceiptError();
  }
  if (namePassword !== undefined && namePasswordNotice !== undefined) {
    status?.(namePasswordNotice);
  }
  return {
    client_message_id: clientMessageId,
    conversation_url: conversationUrl,
    message: { created_at: value.message.created_at, id: value.message.id, sequence: value.message.sequence },
    message_sequence: value.message.sequence,
    ...(namePassword === undefined ? {} : { name_password: namePassword }),
    ...(namePasswordNotice === undefined ? {} : { name_password_notice: namePasswordNotice }),
    replayed: value.replayed,
    wait: foregroundWait(conversationUrl, value.wait.after),
  };
}

function postUsage(): string {
  return "Usage: msg post <conversation-url> --author <author> [--display-name <display-name>] [--name-password <password>] [--content <content>] [--client-message-id <id>] [--based-on-sequence N]";
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

function isGeneratedNamePassword(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length === 8;
}

function parseBasedOnSequence(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("--based-on-sequence must be a nonnegative safe integer.");
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new Error("--based-on-sequence must be a nonnegative safe integer.");
  return sequence;
}

async function readStalePostError(
  response: Response,
  conversationUrl: string,
  basedOnSequence: number | undefined,
  signal: AbortSignal | undefined,
): Promise<Error | undefined> {
  let value: unknown;
  try {
    value = await response.json();
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof PostSignalError) throw error;
    if (signal?.aborted) throw new PostSignalError();
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value.error) || value.error.code !== "stale_sequence") return undefined;
  const latestMessage = value.error.latest_message;
  const reviewAfter = value.error.review_after;
  if (!isNonnegativeSafeInteger(latestMessage) || !isNonnegativeSafeInteger(reviewAfter) || reviewAfter >= latestMessage || basedOnSequence !== undefined && reviewAfter !== basedOnSequence) return undefined;
  const reviewCommand = `msg join ${shellQuote(conversationUrl)} --after ${reviewAfter} --through ${latestMessage} --limit 20`;
  return new Error(`The post was based on sequence ${reviewAfter}, but the room is now at sequence ${latestMessage}. Review the intervening messages and explicitly resubmit with an updated --based-on-sequence. Review command: ${reviewCommand}`);
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

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

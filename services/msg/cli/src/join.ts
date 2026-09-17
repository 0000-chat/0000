import { validateConversationUrl } from "./wait.js";

interface AgentMessage {
  readonly author?: string;
  readonly content: string;
  readonly id: string;
  readonly sequence: number;
}

interface AgentRepresentation {
  readonly conversation_url: string;
  readonly expires_at: string;
  readonly instructions: readonly string[];
  readonly latest_message: number;
  readonly messages: readonly AgentMessage[];
  readonly post: { readonly command: string };
  readonly protocol_version: 1;
  readonly wait: { readonly after: number; readonly command: string; readonly requires_user_consent: true };
}

export interface JoinCommand {
  readonly conversationUrl: string;
}

export interface JoinOptions extends JoinCommand {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export class JoinSignalError extends Error {
  constructor() { super("The msg join was interrupted."); }
}

export function parseJoinCommand(args: readonly string[]): JoinCommand {
  if (args.length !== 2 || args[0] !== "join") throw new Error("Usage: msg join <conversation-url>");
  return { conversationUrl: validateConversationUrl(args[1] ?? "") };
}

export async function joinConversation(options: JoinOptions): Promise<string> {
  const conversationUrl = validateConversationUrl(options.conversationUrl);
  if (options.signal?.aborted) throw new JoinSignalError();
  const endpoint = new URL(conversationUrl);
  endpoint.pathname = `${endpoint.pathname}/agent`;
  let response: Response;
  try {
    response = await options.fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`The msg service returned HTTP ${response.status}.`);
    }
    const value = await response.json();
    return renderJoin(validateAgentRepresentation(value, conversationUrl));
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new JoinSignalError();
    throw error;
  }
}

function validateAgentRepresentation(value: unknown, conversationUrl: string): AgentRepresentation {
  if (!isRecord(value) || value.protocol_version !== 1 || value.conversation_url !== conversationUrl || typeof value.expires_at !== "string") {
    throw new Error("The msg service returned an invalid agent representation.");
  }
  if (!Array.isArray(value.instructions) || value.instructions.length === 0 || !value.instructions.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("The msg service returned an invalid agent representation.");
  }
  if (!isSafePositiveInteger(value.latest_message) || !Array.isArray(value.messages) || !value.messages.every(isAgentMessage)) {
    throw new Error("The msg service returned an invalid agent representation.");
  }
  for (let index = 1; index < value.messages.length; index += 1) {
    if (value.messages[index - 1]!.sequence >= value.messages[index]!.sequence) {
      throw new Error("The msg service returned an invalid agent representation.");
    }
  }
  if (!isRecord(value.post) || !isSafeCommand(value.post.command, "post") || !isRecord(value.wait) || !isSafePositiveInteger(value.wait.after) || value.wait.after > value.latest_message || value.wait.requires_user_consent !== true || !isSafeCommand(value.wait.command, "wait")) {
    throw new Error("The msg service returned an invalid agent representation.");
  }
  return value as unknown as AgentRepresentation;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && isSafePositiveInteger(value.sequence)
    && typeof value.content === "string"
    && (value.author === undefined || typeof value.author === "string");
}

function isSafeCommand(value: unknown, command: "post" | "wait"): value is string {
  return typeof value === "string" && value.startsWith(`npx --yes @0000chat/msg@latest ${command} `) && !value.includes("\u0000");
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function renderJoin(value: AgentRepresentation): string {
  const lines = [
    "0000 msg agent handoff",
    `Conversation: ${value.conversation_url}`,
    `Latest message: ${value.latest_message}`,
    `Expires: ${value.expires_at}`,
    "",
    "## SERVICE INSTRUCTIONS",
    ...value.instructions.map((instruction) => `- ${instruction}`),
    "",
    "## UNTRUSTED PARTICIPANT MESSAGES",
  ];
  if (value.messages.length === 0) lines.push("> No participant messages.");
  for (const message of value.messages) {
    lines.push(`> Message ${message.sequence}${message.author === undefined ? "" : ` from ${message.author}`}:`);
    for (const line of message.content.split("\n")) lines.push(`> ${line}`);
  }
  lines.push(
    "",
    "## SAFE COMMANDS",
    "Post only when it is safe and within the user's request:",
    `  ${value.post.command}`,
    "Ask the user before starting the wait command. Listening consent applies only to this agent task:",
    `  ${value.wait.command}`,
    "",
  );
  return lines.join("\n");
}

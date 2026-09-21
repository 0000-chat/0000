import { cliPrefix, PRODUCTION_ORIGIN, sameOrigin, shellQuote, validateChatUrl, validateGroupUrl, validateOrigin } from "./urls.js";

export const ORGANIZATION_USAGE = [
  "Usage: msg create --author <author> [--title <title>] [--content <content>] [--origin <origin>] [--idempotency-key <key>]",
  "Usage: msg branch <source-url> --from <message-sequence> --title <title> --author <author> [--content <selected-context>] [--idempotency-key <key>]",
  "Usage: msg links <conversation-url> list | add <other-url> [--from <source-message>] | remove <other-url>",
  "Usage: msg groups create --name <name> [--origin <origin>]",
  "Usage: msg groups <group-url> list | add <conversation-url> | remove <conversation-url> | rename <name>",
  "Create and branch accept content on stdin. Links share both chats; groups share member chats. No command starts listening or another harness session.",
].join("\n");

type Creation = { readonly action: "create" | "branch"; readonly origin: string; readonly author: string; readonly title?: string; readonly content?: string; readonly key?: string; readonly source?: string; readonly from?: number };
type RequestCommand = { readonly action: "request"; readonly url: string; readonly method: string; readonly body?: unknown; readonly result: "links" | "group" };
export type OrganizationCommand = Creation | RequestCommand;
export interface OrganizationRuntime {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly generatedClientMessageId?: () => string;
  readonly stdinIsTTY?: boolean;
  readonly readStdin?: (signal?: AbortSignal) => Promise<string>;
}
export class OrganizationSignalError extends Error { constructor() { super("The msg command was interrupted."); } }
export class IncompleteBranchError extends Error {
  constructor(readonly receipt: Record<string, unknown>) { super("The chat was created, but linking did not complete. Use recovery_command from the JSON receipt; do not create another chat."); }
}

export function parseOrganizationCommand(args: readonly string[]): OrganizationCommand {
  if (args[0] === "create" || args[0] === "branch") {
    const branch = args[0] === "branch", source = branch ? validateChatUrl(args[1] ?? "") : undefined;
    const opts = flags(args.slice(branch ? 2 : 1), branch ? ["--author", "--title", "--content", "--from", "--idempotency-key"] : ["--author", "--title", "--content", "--origin", "--idempotency-key"]);
    const author = label(opts["--author"], "--author", 80);
    const title = branch || opts["--title"] !== undefined ? label(opts["--title"], "--title", 120) : undefined;
    const from = branch ? sequence(opts["--from"]) : undefined;
    const origin = source ? new URL(source).origin : validateOrigin(opts["--origin"] ?? PRODUCTION_ORIGIN);
    const key = opts["--idempotency-key"];
    if (key !== undefined) validateKey(key);
    return { action: branch ? "branch" : "create", author, title, from, origin, source, key, content: opts["--content"] };
  }
  if (args[0] === "links") {
    const url = validateChatUrl(args[1] ?? ""), operation = args[2];
    if (operation === "list" && args.length === 3) return { action: "request", url: url + "/links", method: "GET", result: "links" };
    if (operation === "add" || operation === "remove") {
      const target = validateChatUrl(args[3] ?? ""); sameOrigin(url, target);
      if (target === url) throw Error("Choose a different conversation.");
      if (operation === "remove" && args.length === 4) return { action: "request", url: url + "/links" + new URL(target).pathname, method: "DELETE", result: "links" };
      if (operation === "add") {
        const opts = flags(args.slice(4), ["--from"]);
        return { action: "request", url: url + "/links", method: "POST", body: { conversation_url: target, ...(opts["--from"] === undefined ? {} : { source_message: sequence(opts["--from"]) }) }, result: "links" };
      }
    }
  }
  if (args[0] === "groups") {
    if (args[1] === "create") {
      const opts = flags(args.slice(2), ["--name", "--origin"]);
      return { action: "request", url: validateOrigin(opts["--origin"] ?? PRODUCTION_ORIGIN) + "/groups", method: "POST", body: { name: label(opts["--name"], "--name", 80) }, result: "group" };
    }
    const group = validateGroupUrl(args[1] ?? ""), url = new URL(group); url.pathname = url.pathname.replace("/g/", "/groups/");
    if (args[2] === "list" && args.length === 3) return { action: "request", url: url.href, method: "GET", result: "group" };
    if (args[2] === "rename" && args.length === 4) return { action: "request", url: url.href, method: "PATCH", body: { name: label(args[3], "name", 80) }, result: "group" };
    if ((args[2] === "add" || args[2] === "remove") && args.length === 4) {
      const chat = validateChatUrl(args[3]); sameOrigin(group, chat);
      return args[2] === "add"
        ? { action: "request", url: url.href + "/chats", method: "POST", body: { conversation_url: chat }, result: "group" }
        : { action: "request", url: url.href + "/chats" + new URL(chat).pathname, method: "DELETE", result: "group" };
    }
  }
  throw Error(ORGANIZATION_USAGE);
}

export async function runOrganization(command: OrganizationCommand, runtime: OrganizationRuntime): Promise<unknown> {
  aborted(runtime);
  if (command.action === "request") {
    const response = await request(runtime, command.url, command.method, command.body);
    if (command.result === "links") return { links: validateListedChats(response.links, command.url, true) };
    return validateGroup(response, command.url);
  }
  const content = await readContent(command.content, runtime);
  if (!content.trim() || new TextEncoder().encode(content).byteLength > 64 * 1024) throw Error("Content must be nonempty and at most 64 KiB.");
  const key = command.key ?? runtime.generatedClientMessageId?.();
  if (key === undefined) throw Error("The creation runtime is unavailable. Supply --idempotency-key.");
  validateKey(key);
  if (command.action === "branch") {
    const source = await request(runtime, command.source!);
    if (source.conversation_url !== command.source || !Number.isSafeInteger(source.latest_message) || (source.latest_message as number) < command.from!) throw Error("The source message does not exist. No new chat was created.");
  }
  let created: Record<string, unknown>;
  try {
    const response = await request(runtime, command.origin + "/", "POST", { author: command.author, content, ...(command.title ? { title: command.title } : {}) }, key);
    if (typeof response.conversation_url !== "string") throw Error("The creation response did not contain a conversation URL.");
    const url = validateChatUrl(response.conversation_url); sameOrigin(command.origin, url);
    created = { protocol_version: 1, conversation_url: url, idempotency_key: key, ...(typeof response.share_message === "string" ? { share_message: response.share_message } : {}), join_command: `${cliPrefix(url)} join ${shellQuote(url)}` };
  } catch (error) {
    if (runtime.signal?.aborted) throw new OrganizationSignalError();
    throw Error(`Creation did not return a usable receipt (idempotency key: ${key}). Check the service before retrying; creation is not automatically retried. ${message(error)}`);
  }
  if (command.action === "create") return created;
  const recovery = `${cliPrefix(command.source!)} links ${shellQuote(command.source!)} add ${shellQuote(created.conversation_url as string)} --from ${command.from}`;
  const receipt = { ...created, source_url: command.source, source_message: command.from };
  try {
    await request(runtime, command.source! + "/links", "POST", { conversation_url: created.conversation_url, source_message: command.from });
  } catch {
    // Also preserve the created URL if interrupted between creation and linking.
    throw new IncompleteBranchError({ ...receipt, linked: false, recovery_command: recovery });
  }
  return { ...receipt, linked: true };
}

export async function readContent(inline: string | undefined, runtime: OrganizationRuntime): Promise<string> {
  aborted(runtime);
  if (inline !== undefined) {
    if (runtime.stdinIsTTY === false && runtime.readStdin && (await runtime.readStdin(runtime.signal)).length) throw Error("Content must come from either --content or stdin, not both.");
    return inline;
  }
  if (runtime.stdinIsTTY || !runtime.readStdin) throw Error("Supply --content or pipe selected context on stdin.");
  return runtime.readStdin(runtime.signal);
}

async function request(runtime: OrganizationRuntime, url: string, method = "GET", body?: unknown, key?: string): Promise<Record<string, unknown>> {
  aborted(runtime);
  try {
    const response = await runtime.fetch(url, { method, redirect: "error", signal: runtime.signal, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: unknown = await response.json();
    aborted(runtime);
    if (!response.ok) throw Error(isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" ? value.error.message : `The msg service returned HTTP ${response.status}.`);
    if (!isRecord(value)) throw Error("The msg service returned an invalid response.");
    return value;
  } catch (error) { if (runtime.signal?.aborted) throw new OrganizationSignalError(); throw error; }
}

export function validateListedChats(value: unknown, origin: string, links = false): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 50) throw Error("The msg service returned an invalid chat list.");
  return value.map(chat => {
    if (!isRecord(chat) || typeof chat.conversation_url !== "string" || typeof chat.title !== "string" || !["active", "unavailable", "unknown"].includes(String(chat.status))) throw Error("The msg service returned an invalid chat list.");
    const url = validateChatUrl(chat.conversation_url); sameOrigin(origin, url);
    if (links && (!["related", "source", "branch"].includes(String(chat.kind)) || (chat.kind === "related" ? chat.source_message !== null : !Number.isSafeInteger(chat.source_message) || (chat.source_message as number) < 1))) throw Error("The msg service returned an invalid connection.");
    return { conversation_url: url, title: chat.title, status: chat.status, ...(typeof chat.expires_at === "string" ? { expires_at: chat.expires_at } : {}), ...(Number.isSafeInteger(chat.latest_message) ? { latest_message: chat.latest_message } : {}), ...(links ? { kind: chat.kind, source_message: chat.source_message } : {}) };
  });
}
function validateGroup(value: Record<string, unknown>, origin: string): Record<string, unknown> {
  if (typeof value.group_url !== "string" || typeof value.name !== "string" || typeof value.expires_at !== "string") throw Error("The msg service returned an invalid group.");
  const group = validateGroupUrl(value.group_url); sameOrigin(origin, group);
  return { group_url: group, name: value.name, expires_at: value.expires_at, chats: validateListedChats(value.chats, origin) };
}
function flags(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const value: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], next = args[i + 1];
    if (!allowed.includes(flag) || next === undefined || value[flag] !== undefined) throw Error(`Invalid or repeated option: ${flag}.\n${ORGANIZATION_USAGE}`);
    value[flag] = next;
  }
  return value;
}
export function sequence(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw Error("A positive message sequence is required.");
  return Number(value);
}
function label(value: string | undefined, field: string, max: number): string {
  if (!value?.trim() || value.length > max || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw Error(`${field} must be a single line of 1–${max} characters.`);
  return value.trim();
}
function validateKey(value: string): void { if (!/^[\x21-\x7e]{1,128}$/u.test(value)) throw Error("The idempotency key must contain 1–128 printable ASCII characters without spaces."); }
function aborted(runtime: OrganizationRuntime): void { if (runtime.signal?.aborted) throw new OrganizationSignalError(); }
function message(error: unknown): string { return error instanceof Error ? error.message : "Request failed."; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

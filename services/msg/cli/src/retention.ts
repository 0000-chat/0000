const USAGE = "Usage: msg retention <management-url> inspect | extend";
const PRODUCTION_ORIGIN = "https://msg.0000.chat";
const ABSOLUTE_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export type RetentionCommand =
  | { readonly managementUrl: string; readonly operation: "inspect" }
  | { readonly managementUrl: string; readonly operation: "extend" };

export type RetentionOptions = RetentionCommand & {
  readonly fetch: typeof globalThis.fetch;
  readonly readStdin?: (signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
}

export class RetentionSignalError extends Error {
  constructor() { super("The msg retention command was interrupted."); }
}

export function parseRetentionCommand(args: readonly string[]): RetentionCommand {
  if (args.length !== 3 || args[0] !== "retention" || (args[2] !== "inspect" && args[2] !== "extend")) throw new Error(USAGE);
  return { managementUrl: validateManagementUrl(args[1] ?? ""), operation: args[2] };
}

export async function runRetention(options: RetentionOptions): Promise<unknown> {
  if (options.signal?.aborted) throw new RetentionSignalError();
  const endpoint = new URL(options.managementUrl);
  let body: string | undefined;
  if (options.operation === "extend") {
    if (!options.readStdin) throw new Error("Retention extension requires one JSON object on stdin.");
    let input: string;
    try {
      input = await options.readStdin(options.signal);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw new RetentionSignalError();
      throw new Error("The msg retention input could not be read.");
    }
    body = validateExtensionJson(input);
    endpoint.pathname = `${endpoint.pathname}/retention`;
  }
  let response: Response;
  try {
    response = await options.fetch(endpoint, {
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? { method: "GET" } : { body, method: "POST" }),
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new RetentionSignalError();
    throw new Error("The msg retention request failed.");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new RetentionSignalError();
    if (response.ok) throw new Error("The msg service returned an invalid JSON response.");
    throw new Error(responseMessage(response.status, undefined));
  }
  if (!response.ok) throw new Error(responseMessage(response.status, value));
  if (!isRecord(value)) throw new Error("The msg service returned an invalid JSON response.");
  return value;
}

export function validateManagementUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The retention management URL is invalid."); }
  if (url.origin !== PRODUCTION_ORIGIN || url.username || url.password || url.search || url.hash || !/^\/manage\/[^/]+\/[^/]+$/u.test(url.pathname)) {
    throw new Error("The retention management URL is invalid.");
  }
  return url.toString();
}

function validateExtensionJson(value: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Retention extension stdin must contain one JSON object."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Retention extension stdin must contain one JSON object.");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "client_retry_id") || !Object.hasOwn(record, "expires_at") || typeof record.client_retry_id !== "string" || record.client_retry_id.length === 0 || typeof record.expires_at !== "string" || !validAbsoluteIso(record.expires_at)) {
    throw new Error("Retention extension stdin must contain only client_retry_id and a valid absolute expires_at.");
  }
  return JSON.stringify({ client_retry_id: record.client_retry_id, expires_at: record.expires_at });
}

function validAbsoluteIso(value: string): boolean {
  const match = ABSOLUTE_ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  const zone = match[8]!;
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 && offsetHours <= 23 && offsetMinutes <= 59 && Number.isSafeInteger(Date.parse(value));
}

function responseMessage(status: number, value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string" && value.error.message.length > 0 && value.error.message.length <= 240 && !/https?:\/\//iu.test(value.error.message)) return value.error.message;
  return `The msg service returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"; }

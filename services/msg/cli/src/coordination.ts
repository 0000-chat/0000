import { validateConversationUrl } from "./wait.js";

const USAGE = "Usage: msg coordination <conversation-url> overview | panel [--revision N] | panel-history [--after N] [--limit N] [--through N] | proposals [--after N] [--limit N] [--through N] | proposal <proposal-id> [--revision N] | requests [--after N] [--limit N] [--through N] [--owner-label LABEL] [--status STATUS] | request <request-id> [--after N] [--limit N] [--through N] | decisions [--after N] [--limit N] [--through N] | decision <decision-id> [--after N] [--limit N] [--through N] | decision-record <decision-id> <accepted-record-id> | publication <published-revision> | corrections [selectors] | correction <correction-id> | disputes [selectors] | dispute <report-id> [selectors] | supersessions [selectors] | propose | correct | supersede | report | revise <proposal-id> | review <management-coordination-url> <report-id> | publish <management-coordination-url>";

const COORDINATION_STATUSES = new Set(["open", "in_progress", "blocked", "done", "withdrawn"]);

export type CoordinationCommand =
  | { readonly conversationUrl: string; readonly operation: "overview" }
  | { readonly conversationUrl: string; readonly operation: "panel"; readonly revision?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly limit?: number; readonly operation: "panel-history"; readonly through?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly limit?: number; readonly operation: "proposals" | "requests"; readonly ownerLabel?: string; readonly status?: string; readonly through?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly id: string; readonly limit?: number; readonly operation: "proposal" | "request"; readonly revision?: number; readonly through?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly id: string; readonly limit?: number; readonly operation: "decision"; readonly through?: number }
  | { readonly conversationUrl: string; readonly operation: "publication"; readonly revision: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly limit?: number; readonly operation: "corrections"; readonly targetClaimPath?: readonly (string | number)[]; readonly targetMessageId?: string; readonly targetPublishedRevision?: number; readonly targetType?: "message" | "publication"; readonly through?: number }
  | { readonly conversationUrl: string; readonly id: string; readonly operation: "correction" }
  | { readonly acceptedRecordId?: string; readonly after?: number; readonly conversationUrl: string; readonly kind?: "dispute" | "approval_withdrawal"; readonly limit?: number; readonly operation: "disputes"; readonly through?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly id: string; readonly limit?: number; readonly operation: "dispute"; readonly through?: number }
  | { readonly after?: number; readonly conversationUrl: string; readonly limit?: number; readonly operation: "supersessions"; readonly predecessorAcceptedRecordId?: string; readonly successorDecisionId?: string; readonly through?: number }
  | { readonly conversationUrl: string; readonly decisionId: string; readonly operation: "decision-record"; readonly recordId: string }
  | { readonly after?: number; readonly conversationUrl: string; readonly limit?: number; readonly operation: "decisions"; readonly through?: number }
  | { readonly conversationUrl: string; readonly operation: "propose" }
  | { readonly conversationUrl: string; readonly operation: "correct" | "supersede" | "report" }
  | { readonly conversationUrl: string; readonly operation: "revise"; readonly id: string }
  | { readonly managementUrl: string; readonly operation: "review"; readonly reportId: string }
  | { readonly managementUrl: string; readonly operation: "publish" };

export type CoordinationOptions = CoordinationCommand & {
  readonly fetch: typeof globalThis.fetch;
  readonly readStdin?: (signal?: AbortSignal) => Promise<string>;
  readonly signal?: AbortSignal;
};

export class CoordinationSignalError extends Error {
  constructor() { super("The msg coordination command was interrupted."); }
}

export function parseCoordinationCommand(args: readonly string[]): CoordinationCommand {
  if (args[0] !== "coordination" || args.length < 3) throw new Error(USAGE);
  if (args[1] === "publish" && args.length === 3 || args[2] === "publish" && args.length === 4) {
    return { managementUrl: validateManagementCoordinationUrl(args[1] === "publish" ? args[2] ?? "" : args[3] ?? ""), operation: "publish" };
  }
  if (args[1] === "review" && args.length === 4) {
    return { managementUrl: validateManagementCoordinationUrl(args[2] ?? ""), operation: "review", reportId: parseIdentifier(args[3] ?? "") };
  }
  const conversationUrl = validateConversationUrl(args[1] ?? "");
  const operation = args[2];
  if (operation === "overview" || operation === "propose" || operation === "correct" || operation === "supersede" || operation === "report" || operation === "revise" && args.length === 4) {
    if (operation === "overview" && args.length === 3) return { conversationUrl, operation };
    if (operation === "propose" && args.length === 3) return { conversationUrl, operation };
    if ((operation === "correct" || operation === "supersede" || operation === "report") && args.length === 3) return { conversationUrl, operation };
    if (operation === "revise" && args.length === 4 && args[3]) return { conversationUrl, id: args[3], operation };
  }
  if (operation === "panel") {
    if (args.length === 3) return { conversationUrl, operation };
    if (args.length === 5 && args[3] === "--revision") return { conversationUrl, operation, revision: parsePositiveInteger(args[4] ?? "") };
    throw new Error(USAGE);
  }
  if (operation === "panel-history") {
    const selectors: { after?: number; limit?: number; through?: number } = {};
    const seen = new Set<string>();
    for (let index = 3; index < args.length; index += 2) {
      const flag = args[index];
      const raw = args[index + 1];
      if ((flag !== "--after" && flag !== "--limit" && flag !== "--through") || raw === undefined || seen.has(flag)) throw new Error(USAGE);
      seen.add(flag);
      if (flag === "--limit") selectors.limit = parseLimit(raw);
      else if (flag === "--after") selectors.after = parseNonnegativeInteger(raw);
      else selectors.through = parseNonnegativeInteger(raw);
    }
    return { conversationUrl, operation, ...selectors };
  }
  if (operation === "publication") {
    if (args.length !== 4) throw new Error(USAGE);
    return { conversationUrl, operation, revision: parsePositiveInteger(args[3] ?? "") };
  }
  if (operation === "correction") {
    if (args.length !== 4 || !args[3]) throw new Error(USAGE);
    return { conversationUrl, id: parseIdentifier(args[3]), operation };
  }
  if (operation === "corrections") {
    const selectors = parseCoordinationSelectors(args, { target: true });
    return { conversationUrl, operation, ...selectors };
  }
  if (operation === "dispute") {
    if (args.length < 4 || !args[3]) throw new Error(USAGE);
    const selectors = parseCoordinationSelectors(args.slice(4), { target: false });
    return { conversationUrl, id: parseIdentifier(args[3]), operation, ...selectors };
  }
  if (operation === "disputes") {
    const selectors = parseCoordinationSelectors(args, { target: false, dispute: true });
    return { conversationUrl, operation, ...selectors };
  }
  if (operation === "supersessions") {
    const selectors = parseCoordinationSelectors(args, { target: false, supersession: true });
    return { conversationUrl, operation, ...selectors };
  }
  if (operation === "proposals" || operation === "requests" || operation === "decisions") {
    const selectors: { after?: number; limit?: number; ownerLabel?: string; status?: string; through?: number } = {};
    const seen = new Set<string>();
    for (let index = 3; index < args.length; index += 2) {
      const flag = args[index];
      const raw = args[index + 1];
      if ((flag !== "--after" && flag !== "--limit" && flag !== "--through" && flag !== "--owner-label" && flag !== "--status") || raw === undefined || seen.has(flag)) throw new Error(USAGE);
      seen.add(flag);
      if (flag === "--limit") selectors.limit = parseLimit(raw);
      else if (flag === "--after") selectors.after = parseNonnegativeInteger(raw);
      else if (flag === "--owner-label") selectors.ownerLabel = parseLabel(raw);
      else if (flag === "--status") selectors.status = parseStatus(raw);
      else selectors.through = parseNonnegativeInteger(raw);
    }
    if ((operation === "proposals" || operation === "decisions") && (selectors.ownerLabel !== undefined || selectors.status !== undefined)) throw new Error(USAGE);
    return { conversationUrl, operation, ...selectors };
  }
  if (operation === "decision-record" && args.length === 5 && args[3] && args[4]) return { conversationUrl, decisionId: args[3], operation, recordId: args[4] };
  if (operation === "proposal" || operation === "request" || operation === "decision") {
    if (args.length < 4 || !args[3]) throw new Error(USAGE);
    let revision: number | undefined;
    const selectors: { after?: number; limit?: number; through?: number } = {};
    if (operation === "proposal") {
      if (args.length === 6 && args[4] === "--revision") revision = parsePositiveInteger(args[5] ?? "");
      else if (args.length !== 4) throw new Error(USAGE);
      return { conversationUrl, id: args[3], operation, ...(revision === undefined ? {} : { revision }) };
    }
    const seen = new Set<string>();
    for (let index = 4; index < args.length; index += 2) {
      const flag = args[index];
      const raw = args[index + 1];
      if ((flag !== "--after" && flag !== "--limit" && flag !== "--through") || raw === undefined || seen.has(flag)) throw new Error(USAGE);
      seen.add(flag);
      if (flag === "--after") selectors.after = parseNonnegativeInteger(raw);
      else if (flag === "--limit") selectors.limit = parseLimit(raw);
      else selectors.through = parseNonnegativeInteger(raw);
    }
    return { conversationUrl, id: args[3], operation, ...selectors };
  }
  throw new Error(USAGE);
}

export async function runCoordination(options: CoordinationOptions): Promise<unknown> {
  throwIfAborted(options.signal);
  const endpoint = coordinationEndpoint(options);
  const body = options.operation === "propose" || options.operation === "revise" || options.operation === "correct" || options.operation === "supersede" || options.operation === "report" || options.operation === "review" || options.operation === "publish"
    ? await readMutationBody(options)
    : undefined;
  const response = await fetchCoordination(options, endpoint, body);
  const value = await readJson(response, options.signal);
  if (!response.ok) throw new Error(responseMessage(response.status, value));
  if (options.operation === "propose" || options.operation === "revise" || options.operation === "correct" || options.operation === "supersede" || options.operation === "report" || options.operation === "review" || options.operation === "publish") return validateMutationReceipt(options.operation, value);
  return value;
}

function coordinationEndpoint(options: CoordinationOptions): URL {
  if (options.operation === "publish") return new URL(options.managementUrl);
  if (options.operation === "review") {
    const url = new URL(options.managementUrl);
    url.pathname = url.pathname.replace(/\/coordination\/publish$/u, `/coordination/disputes/${encodeURIComponent(options.reportId)}/review`);
    return url;
  }
  const url = new URL(validateConversationUrl(options.conversationUrl));
  if (options.operation === "overview") url.pathname += "/coordination";
  else if (options.operation === "panel") url.pathname += "/coordination/panel";
  else if (options.operation === "panel-history") url.pathname += "/coordination/panel/history";
  else if (options.operation === "proposals" || options.operation === "propose" || options.operation === "correct" || options.operation === "supersede") url.pathname += "/coordination/proposals";
  else if (options.operation === "corrections" || options.operation === "correction") url.pathname += "/coordination/corrections";
  else if (options.operation === "disputes" || options.operation === "dispute" || options.operation === "report") url.pathname += "/coordination/disputes";
  else if (options.operation === "supersessions") url.pathname += "/coordination/supersessions";
  else if (options.operation === "publication") url.pathname += "/coordination/publications";
  else if (options.operation === "proposal" || options.operation === "revise") url.pathname += `/coordination/proposals/${encodeURIComponent(options.id)}`;
  else if (options.operation === "requests") url.pathname += "/coordination/requests";
  else if (options.operation === "request") url.pathname += `/coordination/requests/${encodeURIComponent(options.id)}`;
  else if (options.operation === "decisions") url.pathname += "/coordination/decisions";
  else if (options.operation === "decision" || options.operation === "decision-record") url.pathname += `/coordination/decisions/${encodeURIComponent(options.operation === "decision" ? options.id : options.decisionId)}`;
  else throw new Error(USAGE);
  if (options.operation === "revise") url.pathname += "/revisions";
  if (options.operation === "proposal" && options.revision !== undefined) url.pathname += `/revisions/${options.revision}`;
  if (options.operation === "panel" && options.revision !== undefined) url.searchParams.set("revision", String(options.revision));
  if (options.operation === "proposals" || options.operation === "requests" || options.operation === "decisions" || options.operation === "panel-history" || options.operation === "corrections" || options.operation === "disputes" || options.operation === "supersessions") {
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.operation === "requests" && options.ownerLabel !== undefined) url.searchParams.set("owner_label", options.ownerLabel);
    if (options.operation === "requests" && options.status !== undefined) url.searchParams.set("status", options.status);
    if (options.operation === "corrections") {
      if (options.targetType !== undefined) url.searchParams.set("target_type", options.targetType);
      if (options.targetMessageId !== undefined) url.searchParams.set("target_message_id", options.targetMessageId);
      if (options.targetPublishedRevision !== undefined) url.searchParams.set("target_published_revision", String(options.targetPublishedRevision));
      if (options.targetClaimPath !== undefined) url.searchParams.set("target_claim_path", JSON.stringify(options.targetClaimPath));
    }
    if (options.operation === "disputes") {
      if (options.acceptedRecordId !== undefined) url.searchParams.set("accepted_record_id", options.acceptedRecordId);
      if (options.kind !== undefined) url.searchParams.set("kind", options.kind);
    }
    if (options.operation === "supersessions") {
      if (options.predecessorAcceptedRecordId !== undefined) url.searchParams.set("predecessor_accepted_record_id", options.predecessorAcceptedRecordId);
      if (options.successorDecisionId !== undefined) url.searchParams.set("successor_decision_id", options.successorDecisionId);
    }
    if (options.through !== undefined) url.searchParams.set("through", String(options.through));
  }
  if (options.operation === "request") {
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.through !== undefined) url.searchParams.set("through", String(options.through));
  }
  if (options.operation === "dispute") {
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.through !== undefined) url.searchParams.set("through", String(options.through));
  }
  if (options.operation === "decision") {
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.through !== undefined) url.searchParams.set("through", String(options.through));
  }
  if (options.operation === "decision-record") url.pathname += `/records/${encodeURIComponent(options.recordId)}`;
  if (options.operation === "publication") url.pathname += `/${options.revision}`;
  if (options.operation === "correction") url.pathname += `/${encodeURIComponent(options.id)}`;
  if (options.operation === "dispute") url.pathname += `/${encodeURIComponent(options.id)}`;
  return url;
}

async function fetchCoordination(options: CoordinationOptions, endpoint: URL, body: string | undefined): Promise<Response> {
  const mutation = body !== undefined;
  try {
    return await options.fetch(endpoint, {
      headers: { accept: "application/json", ...(mutation ? { "content-type": "application/json" } : {}) },
      ...(mutation ? { body, method: "POST" } : { method: "GET" }),
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw new CoordinationSignalError();
    throw error instanceof Error ? error : new Error("The msg coordination request failed.");
  }
}

async function readMutationBody(options: CoordinationOptions): Promise<string> {
  if (!options.readStdin) throw new Error("Structured coordination mutations require JSON on stdin.");
  throwIfAborted(options.signal);
  const text = await options.readStdin(options.signal);
  if (!text.trim()) throw new Error("Structured coordination mutations require JSON on stdin.");
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return JSON.stringify(value);
  } catch {
    throw new Error("The coordination mutation stdin must contain one JSON object.");
  }
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    const value = await response.json();
    throwIfAborted(signal);
    return value;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw new CoordinationSignalError();
    return undefined;
  }
}

function validateManagementCoordinationUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The coordination management URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/manage\/[^/]+\/[^/]+\/coordination\/publish$/u.test(url.pathname)) {
    throw new Error("The coordination management URL is invalid.");
  }
  return url.toString();
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(USAGE);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(USAGE);
  return result;
}

function parseNonnegativeInteger(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(USAGE);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(USAGE);
  return result;
}

function parseLimit(value: string): number {
  const result = parsePositiveInteger(value);
  if (result > 100) throw new Error(USAGE);
  return result;
}

function parseLabel(value: string): string {
  if (value.length === 0 || Array.from(value).length > 80 || new TextEncoder().encode(value).byteLength > 320) throw new Error(USAGE);
  return value;
}

function parseStatus(value: string): string {
  if (!COORDINATION_STATUSES.has(value)) throw new Error(USAGE);
  return value;
}

function parseIdentifier(value: string): string {
  if (value.length === 0 || value.length > 512) throw new Error(USAGE);
  return value;
}

function parseCoordinationSelectors(args: readonly string[], options: { readonly dispute?: boolean; readonly supersession?: boolean; readonly target?: boolean }): Record<string, unknown> {
  const start = args[0]?.startsWith("--") === true ? 0 : 3;
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  const flags = new Set(["--after", "--limit", "--through"]);
  if (options.target) for (const flag of ["--target-type", "--target-message-id", "--target-published-revision", "--target-claim-path"]) flags.add(flag);
  if (options.dispute) for (const flag of ["--accepted-record-id", "--kind"]) flags.add(flag);
  if (options.supersession) for (const flag of ["--predecessor-accepted-record-id", "--successor-decision-id"]) flags.add(flag);
  for (let index = start; index < args.length; index += 2) {
    const flag = args[index]; const raw = args[index + 1];
    if (!flag || !flags.has(flag) || raw === undefined || seen.has(flag)) throw new Error(USAGE);
    seen.add(flag);
    if (flag === "--after") result.after = parseNonnegativeInteger(raw);
    else if (flag === "--limit") result.limit = parseLimit(raw);
    else if (flag === "--through") result.through = parseNonnegativeInteger(raw);
    else if (flag === "--target-type") { if (raw !== "message" && raw !== "publication") throw new Error(USAGE); result.targetType = raw; }
    else if (flag === "--target-message-id") result.targetMessageId = parseIdentifier(raw);
    else if (flag === "--target-published-revision") result.targetPublishedRevision = parsePositiveInteger(raw);
    else if (flag === "--target-claim-path") {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new Error(USAGE); }
      if (!Array.isArray(value) || value.length === 0 || value.length > 8 || value.some((part) => typeof part !== "string" && !(typeof part === "number" && Number.isSafeInteger(part) && part >= 0))) throw new Error(USAGE);
      result.targetClaimPath = value;
    } else if (flag === "--accepted-record-id") result.acceptedRecordId = parseIdentifier(raw);
    else if (flag === "--kind") { if (raw !== "dispute" && raw !== "approval_withdrawal") throw new Error(USAGE); result.kind = raw; }
    else if (flag === "--predecessor-accepted-record-id") result.predecessorAcceptedRecordId = parseIdentifier(raw);
    else if (flag === "--successor-decision-id") result.successorDecisionId = parseIdentifier(raw);
  }
  if (options.target && result.targetType === "message" && result.targetClaimPath !== undefined) throw new Error(USAGE);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CoordinationSignalError();
}

function responseMessage(status: number, value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") return value.error.message;
  return `The msg service returned HTTP ${status}.`;
}

function validateMutationReceipt(operation: "propose" | "revise" | "correct" | "supersede" | "report" | "review" | "publish", value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.replayed !== "boolean") throw new Error("The coordination response was incomplete.");
  if (operation === "report") {
    const report = value.report ?? value.dispute;
    if (!isRecord(report) || !nonemptyString(report.report_id)) throw new Error("The coordination report response was incomplete.");
    return value;
  }
  if (operation === "review") {
    if (!isRecord(value.review) || !nonemptyString(value.review.review_id) || !nonemptyString(value.review.report_id)) throw new Error("The coordination review response was incomplete.");
    return value;
  }
  if (operation === "publish") {
    const proposal = value.proposal;
    const request = value.request;
    const panel = value.panel;
    const decision = value.decision;
    const position = value.position;
    const acceptedRecord = value.accepted_record;
    const correction = value.correction;
    const supersession = value.supersession;
    const hasDecisionResult = isRecord(decision) && nonemptyString(decision.decision_id) && (isRecord(acceptedRecord) && nonemptyString(acceptedRecord.accepted_record_id) || isRecord(position) && nonemptyString(position.position_id) || typeof decision.state === "string");
    if (!isRecord(proposal) || !nonemptyString(proposal.proposal_id) || !positiveInteger(proposal.revision) || !positiveInteger(value.published_revision) || !((isRecord(request) && nonemptyString(request.request_id)) || (isRecord(panel) && nonemptyString(panel.proposal_id)) || (isRecord(correction) && nonemptyString(correction.correction_id)) || (isRecord(supersession) && nonemptyString(supersession.supersession_id)) || hasDecisionResult)) {
      throw new Error("The coordination publication response was incomplete.");
    }
    return value;
  }
  const proposal = value.proposal;
  if (!isRecord(proposal) || !nonemptyString(proposal.proposal_id) || !positiveInteger(proposal.revision) || !(nonemptyString(proposal.request_id) || typeof proposal.kind === "string" && (proposal.kind.startsWith("decision.") || proposal.kind === "claim.correction"))) {
    throw new Error("The coordination proposal response was incomplete.");
  }
  return value;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError") || error instanceof Error && error.name === "AbortError";
}

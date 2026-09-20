import { ERROR_CODES, ProtocolError } from "./errors";
import { byteLength, validateRequestId } from "./room-domain";

export const COORDINATION_DEFAULT_LIMIT = 20;
export const COORDINATION_MAX_LIMIT = 100;
export const COORDINATION_MAX_SOURCE_IDS = 50;
export const COORDINATION_MAX_ARRAY_ITEMS = 50;
export const COORDINATION_MAX_LABEL_CHARS = 80;
export const COORDINATION_MAX_LABEL_BYTES = 320;
export const COORDINATION_MAX_FIELD_CHARS = 2_000;
export const COORDINATION_MAX_FIELD_BYTES = 8 * 1024;
export const COORDINATION_MAX_SOURCE_ID_CHARS = 512;
export const COORDINATION_MAX_SOURCE_ID_BYTES = 2 * 1024;
export const MAX_COORDINATION_PAGE_BYTES = 128 * 1024;
export const COORDINATION_KIND = "request.create" as const;
export const COORDINATION_PROGRESS_KIND = "request.progress" as const;
export const COORDINATION_PANEL_KIND = "panel.replace" as const;
export const COORDINATION_KINDS = [COORDINATION_KIND, COORDINATION_PROGRESS_KIND, COORDINATION_PANEL_KIND] as const;

export type CoordinationKind = (typeof COORDINATION_KINDS)[number];
export type CoordinationStatus = "open" | "in_progress" | "blocked" | "done" | "withdrawn";

export type CoordinationAuthority = "management" | "participant";

export interface CoordinationRequestBody {
  readonly completion_criteria: readonly string[];
  readonly decision_impact: string;
  readonly owner_label: string;
  readonly purpose: string;
  readonly requested_output: string;
  readonly title: string;
  readonly unknowns: readonly string[];
}

export interface CoordinationEvidence {
  readonly artifact_url: string;
  readonly location?: string;
  readonly reported_verification: string;
  readonly remaining_blockers: readonly string[];
}

export interface CoordinationProgressBody {
  readonly blockers: readonly string[];
  readonly evidence: readonly CoordinationEvidence[];
  readonly request_id: string;
  readonly status: CoordinationStatus;
  readonly reopen_reason?: string;
  readonly unverified_explanation?: string;
}

export interface CoordinationPanelArtifact {
  readonly role: string;
  readonly title: string;
  readonly url: string;
}

export interface CoordinationPanelNextAction {
  readonly description: string;
  readonly owner_label: string;
}

export interface CoordinationPanelBody {
  readonly artifacts: readonly CoordinationPanelArtifact[];
  readonly next_actions: readonly CoordinationPanelNextAction[];
  readonly phase: string | null;
  readonly purpose: string | null;
}

export type CoordinationProposalBody = CoordinationRequestBody | CoordinationProgressBody | CoordinationPanelBody;

export interface CoordinationProposalInput {
  readonly actor_label: string;
  readonly base_revision: number;
  readonly body: CoordinationProposalBody;
  readonly client_retry_id: string;
  readonly kind: CoordinationKind;
  readonly source_message_ids: readonly string[];
}

export interface CoordinationPublishInput {
  readonly base_revision: number;
  readonly client_retry_id: string;
  readonly owner_label: string;
  readonly proposal_id: string;
  readonly revision: number;
}

export interface CoordinationListSelectors {
  readonly after: number;
  readonly limit: number;
  readonly owner_label?: string;
  readonly status?: CoordinationStatus;
  readonly through?: number;
}

export function parseCoordinationProposal(value: unknown): CoordinationProposalInput {
  const record = object(value, "The coordination proposal must be a JSON object.");
  allowlist(record, ["client_retry_id", "actor_label", "base_revision", "source_message_ids", "kind", "body"]);
  const clientRetryId = requiredString(record.client_retry_id, "client_retry_id");
  const actorLabel = requiredString(record.actor_label, "actor_label");
  const baseRevision = nonnegativeInteger(record.base_revision, "base_revision");
  const sourceMessageIds = parseSourceIds(record.source_message_ids);
  const kind = record.kind;
  if (kind !== COORDINATION_KIND && kind !== COORDINATION_PROGRESS_KIND && kind !== COORDINATION_PANEL_KIND) throw invalid("The coordination proposal kind is not supported.");
  const body = kind === COORDINATION_KIND ? parseRequestBody(record.body) : kind === COORDINATION_PROGRESS_KIND ? parseProgressBody(record.body) : parsePanelBody(record.body);
  return {
    actor_label: bounded(actorLabel, "actor_label", COORDINATION_MAX_LABEL_CHARS, COORDINATION_MAX_LABEL_BYTES),
    base_revision: baseRevision,
    body,
    client_retry_id: validateRequestId(clientRetryId),
    kind,
    source_message_ids: sourceMessageIds,
  };
}

export function parseCoordinationRevision(value: unknown): CoordinationProposalInput {
  return parseCoordinationProposal(value);
}

export function parseCoordinationPublish(value: unknown): CoordinationPublishInput {
  const record = object(value, "The coordination publication must be a JSON object.");
  allowlist(record, ["client_retry_id", "owner_label", "proposal_id", "revision", "base_revision"]);
  const clientRetryId = requiredString(record.client_retry_id, "client_retry_id");
  const ownerLabel = requiredString(record.owner_label, "owner_label");
  const proposalId = stringField(record.proposal_id, "proposal_id");
  const revision = positiveInteger(record.revision, "revision");
  const baseRevision = nonnegativeInteger(record.base_revision, "base_revision");
  return {
    base_revision: baseRevision,
    client_retry_id: validateRequestId(clientRetryId),
    owner_label: bounded(ownerLabel, "owner_label", COORDINATION_MAX_LABEL_CHARS, COORDINATION_MAX_LABEL_BYTES),
    proposal_id: bounded(proposalId, "proposal_id", 128, 512),
    revision,
  };
}

export function parseCoordinationListSelectors(url: URL): CoordinationListSelectors {
  const after = parseCursor(url.searchParams.get("after"), "after");
  const limit = parseLimit(url.searchParams.get("limit"));
  const throughValue = url.searchParams.get("through");
  const through = throughValue === null ? undefined : parseCursor(throughValue, "through");
  if (through !== undefined && after > through) throw invalid("The after cursor must not be greater than through.");
  const ownerValue = url.searchParams.get("owner_label") ?? url.searchParams.get("owner-label");
  const ownerLabel = ownerValue === null ? undefined : bounded(ownerValue, "owner_label", COORDINATION_MAX_LABEL_CHARS, COORDINATION_MAX_LABEL_BYTES);
  const statusValue = url.searchParams.get("status");
  const status = statusValue === null ? undefined : parseStatus(statusValue);
  return { after, limit, ...(ownerLabel === undefined ? {} : { owner_label: ownerLabel }), ...(status === undefined ? {} : { status }), ...(through === undefined ? {} : { through }) };
}

export function coordinationMutationFingerprint(input: unknown): string {
  return JSON.stringify(input);
}

export function coordinationStorageBytes(value: unknown, id?: string): number {
  return 128 + byteLength(JSON.stringify(value)) + (id === undefined ? 0 : byteLength(id));
}

function parseRequestBody(value: unknown): CoordinationRequestBody {
  const record = object(value, "The coordination request body must be a JSON object.");
  const allowed = new Set(["purpose", "title", "owner_label", "requested_output", "unknowns", "completion_criteria", "decision_impact"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalid("The coordination request body contains an unsupported field.");
  const purpose = optionalString(record.purpose) ?? optionalString(record.title);
  const title = optionalString(record.title) ?? purpose;
  if (purpose === undefined || title === undefined) throw invalid("The coordination request purpose or title is required.");
  const ownerLabel = requiredString(record.owner_label, "owner_label");
  const requestedOutput = requiredString(record.requested_output, "requested_output");
  const unknowns = stringArray(record.unknowns, "unknowns");
  const completionCriteria = stringArray(record.completion_criteria, "completion_criteria");
  const decisionImpact = requiredString(record.decision_impact, "decision_impact");
  return {
    completion_criteria: completionCriteria,
    decision_impact: bounded(decisionImpact, "decision_impact", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES),
    owner_label: bounded(ownerLabel, "owner_label", COORDINATION_MAX_LABEL_CHARS, COORDINATION_MAX_LABEL_BYTES),
    purpose: bounded(purpose, "purpose", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES),
    requested_output: bounded(requestedOutput, "requested_output", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES),
    title: bounded(title, "title", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES),
    unknowns,
  };
}

function parseProgressBody(value: unknown): CoordinationProgressBody {
  const record = object(value, "The coordination progress body must be a JSON object.");
  const allowed = new Set(["request_id", "status", "blockers", "evidence", "unverified_explanation", "reopen_reason"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalid("The coordination progress body contains an unsupported field.");
  const requestId = validateRequestId(requiredString(record.request_id, "request_id"));
  const status = parseStatus(requiredString(record.status, "status"));
  const blockers = stringArray(record.blockers, "blockers");
  const evidence = parseEvidence(record.evidence);
  const unverifiedExplanation = optionalBounded(record.unverified_explanation, "unverified_explanation", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
  const reopenReason = optionalBounded(record.reopen_reason, "reopen_reason", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
  if (status === "done" && evidence.length === 0 && unverifiedExplanation === undefined) {
    throw invalid("A done progress report requires evidence or an explicit unverified explanation.");
  }
  return {
    blockers,
    evidence,
    request_id: requestId,
    status,
    ...(reopenReason === undefined ? {} : { reopen_reason: reopenReason }),
    ...(unverifiedExplanation === undefined ? {} : { unverified_explanation: unverifiedExplanation }),
  };
}

function parsePanelBody(value: unknown): CoordinationPanelBody {
  const record = object(value, "The coordination panel body must be a JSON object.");
  const allowed = new Set(["purpose", "phase", "artifacts", "next_actions"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalid("The coordination panel body contains an unsupported field.");
  const purpose = nullableBounded(record.purpose, "purpose", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
  const phase = nullableBounded(record.phase, "phase", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
  if (!Array.isArray(record.artifacts) || record.artifacts.length > COORDINATION_MAX_ARRAY_ITEMS) throw invalid("The artifacts field must be a bounded array of objects.");
  const artifacts = record.artifacts.map((item) => {
    const artifact = object(item, "Each artifact must be a JSON object.");
    for (const key of Object.keys(artifact)) if (key !== "title" && key !== "url" && key !== "role") throw invalid("The artifact contains an unsupported field.");
    const title = bounded(requiredString(artifact.title, "title"), "title", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
    const role = bounded(requiredString(artifact.role, "role"), "role", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
    const url = absoluteHttpUrl(artifact.url, "url");
    return { role, title, url };
  });
  if (!Array.isArray(record.next_actions) || record.next_actions.length > COORDINATION_MAX_ARRAY_ITEMS) throw invalid("The next_actions field must be a bounded array of objects.");
  const nextActions = record.next_actions.map((item) => {
    const action = object(item, "Each next action must be a JSON object.");
    for (const key of Object.keys(action)) if (key !== "description" && key !== "owner_label") throw invalid("The next action contains an unsupported field.");
    const description = bounded(requiredString(action.description, "description"), "description", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
    const ownerLabel = bounded(requiredString(action.owner_label, "owner_label"), "owner_label", COORDINATION_MAX_LABEL_CHARS, COORDINATION_MAX_LABEL_BYTES);
    return { description, owner_label: ownerLabel };
  });
  return { artifacts, next_actions: nextActions, phase, purpose };
}

function parseEvidence(value: unknown): CoordinationEvidence[] {
  if (!Array.isArray(value) || value.length > COORDINATION_MAX_ARRAY_ITEMS) throw invalid("The evidence field must be a bounded array of objects.");
  return value.map((item) => {
    const record = object(item, "Each evidence item must be a JSON object.");
    const allowed = new Set(["artifact_url", "location", "reported_verification", "remaining_blockers"]);
    for (const key of Object.keys(record)) if (!allowed.has(key)) throw invalid("The evidence item contains an unsupported field.");
    const artifactUrl = requiredString(record.artifact_url, "artifact_url");
    absoluteHttpUrl(artifactUrl, "artifact_url");
    const location = optionalBounded(record.location, "location", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
    const reportedVerification = bounded(requiredString(record.reported_verification, "reported_verification"), "reported_verification", COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
    const remainingBlockers = stringArray(record.remaining_blockers, "remaining_blockers");
    return {
      artifact_url: artifactUrl,
      ...(location === undefined ? {} : { location }),
      reported_verification: reportedVerification,
      remaining_blockers: remainingBlockers,
    };
  });
}

function absoluteHttpUrl(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw invalid(`The ${field} must be an absolute HTTP(S) URL.`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid(`The ${field} must be an absolute HTTP(S) URL.`);
  return bounded(raw, field, COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES);
}

function parseStatus(value: string): CoordinationStatus {
  if (value !== "open" && value !== "in_progress" && value !== "blocked" && value !== "done" && value !== "withdrawn") throw invalid("The coordination status is not supported.");
  return value;
}

function parseSourceIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > COORDINATION_MAX_SOURCE_IDS) throw invalid("source_message_ids must be a bounded array.");
  const result = value.map((item) => bounded(stringField(item, "source_message_ids"), "source_message_id", COORDINATION_MAX_SOURCE_ID_CHARS, COORDINATION_MAX_SOURCE_ID_BYTES));
  if (new Set(result).size !== result.length) throw invalid("source_message_ids must not contain duplicates.");
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > COORDINATION_MAX_ARRAY_ITEMS) throw invalid(`The ${field} field must be a bounded array of strings.`);
  return value.map((item) => bounded(stringField(item, field), field, COORDINATION_MAX_FIELD_CHARS, COORDINATION_MAX_FIELD_BYTES));
}

function allowlist(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw invalid("The coordination mutation contains an unsupported field.");
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  return stringField(value, field);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("Coordination text fields must be strings.");
  return value;
}

function nullableBounded(value: unknown, field: string, maxChars: number, maxBytes: number): string | null {
  if (value === null) return null;
  if (value === undefined) throw invalid(`The ${field} field is required.`);
  return bounded(optionalString(value)!, field, maxChars, maxBytes);
}

function optionalBounded(value: unknown, field: string, maxChars: number, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return bounded(optionalString(value)!, field, maxChars, maxBytes);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(`The ${field} field must be a string.`);
  return value;
}

function bounded(value: string, field: string, maxChars: number, maxBytes: number): string {
  if (Array.from(value).length === 0) throw invalid(`The ${field} field must not be empty.`);
  if (Array.from(value).length > maxChars) throw invalid(`The ${field} field is too long.`);
  if (byteLength(value) > maxBytes) throw new ProtocolError(ERROR_CODES.bodyTooLarge, `The ${field} field is too large.`, 413);
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid(`The ${field} field must be a nonnegative safe integer.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const result = nonnegativeInteger(value, field);
  if (result < 1) throw invalid(`The ${field} field must be a positive safe integer.`);
  return result;
}

function parseCursor(value: string | null, field: string): number {
  if (value === null) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalid(`The ${field} cursor must be a nonnegative safe integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw invalid(`The ${field} cursor must be a nonnegative safe integer.`);
  return result;
}

function parseLimit(value: string | null): number {
  if (value === null) return COORDINATION_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalid(`The coordination limit must be between 1 and ${COORDINATION_MAX_LIMIT}.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > COORDINATION_MAX_LIMIT) throw invalid(`The coordination limit must be between 1 and ${COORDINATION_MAX_LIMIT}.`);
  return result;
}

function invalid(message: string): ProtocolError {
  return new ProtocolError(ERROR_CODES.invalidBody, message, 400);
}

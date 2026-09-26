export const ERROR_CODES = {
  bodyTooLarge: "body_too_large",
  internal: "internal_error",
  invalidBody: "invalid_body",
  invalidJson: "invalid_json",
  conflict: "conflict",
  staleSequence: "stale_sequence",
  staleRevision: "stale_revision",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  gone: "gone",
  notFound: "not_found",
  serviceUnavailable: "service_unavailable",
  unsupportedMediaType: "unsupported_media_type",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface StaleSequenceDetails {
  readonly latest_message: number;
  readonly review_after: number;
}

export interface StaleRevisionDetails {
  readonly current_revision: number;
  readonly submitted_base_revision: number;
}

export function isStaleSequenceDetails(value: unknown): value is StaleSequenceDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return isNonnegativeSafeInteger(details.latest_message)
    && isNonnegativeSafeInteger(details.review_after)
    && details.review_after < details.latest_message;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isStaleRevisionDetails(value: unknown): value is StaleRevisionDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return isNonnegativeSafeInteger(details.current_revision)
    && isNonnegativeSafeInteger(details.submitted_base_revision);
}

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    readonly details?: StaleSequenceDetails | StaleRevisionDetails,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export const ERROR_CODES = {
  bodyTooLarge: "body_too_large",
  internal: "internal_error",
  invalidBody: "invalid_body",
  invalidJson: "invalid_json",
  conflict: "conflict",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  gone: "gone",
  notFound: "not_found",
  serviceUnavailable: "service_unavailable",
  unsupportedMediaType: "unsupported_media_type",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

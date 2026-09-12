import type {
  IngestionErrorCode,
  IngestionErrorResponse,
} from "@communicator/contracts";
import { IngestionErrorResponseSchema } from "@communicator/contracts";

export type { IngestionErrorCode } from "@communicator/contracts";

const SAFE_MESSAGES: Record<IngestionErrorCode, string> = {
  ingestion_invalid: "Invalid ingestion request",
  ingestion_too_large: "Ingestion request is too large",
  ingestion_unauthenticated: "Ingestion authentication failed",
  ingestion_not_found: "Ingestion resource not found",
  ingestion_conflict: "Ingestion conflicts with existing content",
  ingestion_unavailable: "Ingestion service is unavailable",
};

export type IngestionErrorOptions = {
  cause?: unknown;
};

const ingestionErrorCauses = new WeakMap<IngestionError, unknown>();

/**
 * Internal ingestion failures expose only a stable public code and generic
 * message. Diagnostic causes stay in a private weak map and never become part
 * of an HTTP response or serialized error object.
 */
export class IngestionError extends Error {
  readonly code!: IngestionErrorCode;

  constructor(
    code: IngestionErrorCode,
    options: IngestionErrorOptions = {},
  ) {
    super(SAFE_MESSAGES[code]);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "IngestionError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (options.cause !== undefined) ingestionErrorCauses.set(this, options.cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @internal Diagnostic-only access; never expose this through RPC. */
export const getIngestionErrorCause = (
  error: IngestionError,
): unknown => ingestionErrorCauses.get(error);

export const isIngestionError = (
  error: unknown,
): error is IngestionError => error instanceof IngestionError;

export const ingestionError = (
  code: IngestionErrorCode,
  cause?: unknown,
): IngestionError =>
  new IngestionError(code, cause === undefined ? {} : { cause });

export const safeIngestionError = (
  error: unknown,
  fallback: IngestionErrorCode,
): IngestionError =>
  isIngestionError(error) ? error : ingestionError(fallback, error);

/** Build the public error envelope without copying any raw failure detail. */
export const ingestionErrorResponse = (
  error: IngestionError,
): IngestionErrorResponse => {
  const candidate: IngestionErrorResponse = {
    error: {
      code: error.code,
      message: SAFE_MESSAGES[error.code],
    },
  };
  return IngestionErrorResponseSchema.parse(candidate);
};

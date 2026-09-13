import {
  ApiErrorResponseSchema,
  type ApiErrorResponse,
} from "@communicator/contracts";
import {
  DirectoryReadError,
  type DirectoryReadErrorCode,
} from "../control-directory/read-repository";

export type ReadErrorCode =
  | "invalid_request"
  | "forbidden"
  | "not_found"
  | "service_unavailable";

const SAFE_MESSAGES: Record<ReadErrorCode, string> = {
  invalid_request: "Invalid request",
  forbidden: "Forbidden",
  not_found: "Resource not found",
  service_unavailable: "Service unavailable",
};

const readErrorCauses = new WeakMap<ReadError, unknown>();

export class ReadError extends Error {
  readonly code!: ReadErrorCode;

  constructor(code: ReadErrorCode, cause?: unknown) {
    super(SAFE_MESSAGES[code]);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "ReadError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (cause !== undefined) readErrorCauses.set(this, cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const getReadErrorCause = (error: ReadError): unknown =>
  readErrorCauses.get(error);

export const isReadError = (error: unknown): error is ReadError =>
  error instanceof ReadError;

export const readError = (code: ReadErrorCode, cause?: unknown): ReadError =>
  new ReadError(code, cause);

const DIRECTORY_FAILURES: ReadonlySet<DirectoryReadErrorCode> = new Set([
  "read_directory_invalid",
  "read_directory_too_large",
  "read_directory_unavailable",
]);

const PROJECTION_INVALID_CODES = new Set([
  "projection_invalid",
  "projection_conflict",
  "projection_tenant_mismatch",
]);

const PROJECTION_NOT_FOUND_CODES = new Set(["projection_forbidden"]);

const PROJECTION_UNAVAILABLE_CODES = new Set([
  "projection_rebuilding",
  "projection_rebuild_failed",
  "projection_rebuild_mismatch",
  "projection_not_found",
  "projection_too_large",
  "projection_unavailable",
]);

const errorCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
};

/** Convert internal D1/DO failures into the public read error vocabulary. */
export const mapReadError = (error: unknown): ReadError => {
  if (isReadError(error)) return error;
  if (
    error instanceof DirectoryReadError &&
    DIRECTORY_FAILURES.has(error.code)
  ) {
    return readError("service_unavailable", error);
  }

  const code = errorCode(error);
  if (code !== undefined && PROJECTION_INVALID_CODES.has(code)) {
    return readError("invalid_request", error);
  }
  if (code !== undefined && PROJECTION_NOT_FOUND_CODES.has(code)) {
    return readError("not_found", error);
  }
  if (code !== undefined && PROJECTION_UNAVAILABLE_CODES.has(code)) {
    return readError("service_unavailable", error);
  }
  return readError("service_unavailable", error);
};

/** Build a response without copying any internal failure detail. */
export const readErrorResponse = (
  error: unknown,
): {
  status: 400 | 403 | 404 | 503;
  body: ApiErrorResponse;
} => {
  const mapped = mapReadError(error);
  const status =
    mapped.code === "invalid_request"
      ? 400
      : mapped.code === "forbidden"
        ? 403
      : mapped.code === "not_found"
        ? 404
        : 503;
  const body = ApiErrorResponseSchema.parse({
    error: {
      code: mapped.code,
      message: SAFE_MESSAGES[mapped.code],
    },
  });
  return { status, body };
};

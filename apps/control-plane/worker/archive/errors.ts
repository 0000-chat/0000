export type ArchiveErrorCode =
  | "archive_invalid"
  | "archive_tenant_mismatch"
  | "archive_too_large"
  | "archive_conflict"
  | "archive_not_found"
  | "archive_corrupt"
  | "archive_unavailable";

const SAFE_MESSAGES: Record<ArchiveErrorCode, string> = {
  archive_invalid: "Archive input is invalid",
  archive_tenant_mismatch: "Archive tenant mismatch",
  archive_too_large: "Archive exceeds configured bounds",
  archive_conflict: "Archive object conflicts with existing content",
  archive_not_found: "Archive object not found",
  archive_corrupt: "Archive content is corrupt",
  archive_unavailable: "Archive storage is unavailable",
};

export type ArchiveErrorOptions = {
  cause?: unknown;
};

/**
 * Internal archive failures intentionally expose only a stable code and a
 * generic message. Causes are retained for local diagnostics but are not
 * enumerable or serialized with the error.
 */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;

  constructor(
    code: ArchiveErrorCode,
    options: ArchiveErrorOptions | string = {},
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "ArchiveError";
    this.code = code;
    const cause = typeof options === "string" ? undefined : options.cause;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: false,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const isArchiveError = (error: unknown): error is ArchiveError =>
  error instanceof ArchiveError;

export const archiveError = (
  code: ArchiveErrorCode,
  cause?: unknown,
): ArchiveError =>
  new ArchiveError(code, cause === undefined ? {} : { cause });

export const safeArchiveError = (
  error: unknown,
  fallback: ArchiveErrorCode,
): ArchiveError => (isArchiveError(error) ? error : archiveError(fallback, error));

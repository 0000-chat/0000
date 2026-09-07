import type { ProjectionErrorCode } from "@communicator/contracts";

export type { ProjectionErrorCode } from "@communicator/contracts";

export type ProjectionErrorOptions = {
  cause?: unknown;
};

const projectionErrorCauses = new WeakMap<ProjectionError, unknown>();

/**
 * Internal projection failures intentionally expose only a stable code and
 * message. Causes remain available through the module-private diagnostic map
 * without becoming own properties or serialized error data.
 */
export class ProjectionError extends Error {
  readonly code!: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, options: ProjectionErrorOptions = {}) {
    super(code);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "ProjectionError",
      writable: true,
    });
    Object.defineProperty(this, "code", {
      configurable: true,
      enumerable: true,
      value: code,
      writable: false,
    });
    if (options.cause !== undefined) projectionErrorCauses.set(this, options.cause);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** @internal Diagnostic-only access; never expose this through RPC. */
export const getProjectionErrorCause = (
  error: ProjectionError,
): unknown => projectionErrorCauses.get(error);

export const isProjectionError = (
  error: unknown,
): error is ProjectionError => error instanceof ProjectionError;

export const projectionError = (
  code: ProjectionErrorCode,
  cause?: unknown,
): ProjectionError => new ProjectionError(code, cause === undefined ? {} : { cause });

export const safeProjectionError = (
  error: unknown,
  fallback: ProjectionErrorCode,
): ProjectionError => (isProjectionError(error) ? error : projectionError(fallback, error));

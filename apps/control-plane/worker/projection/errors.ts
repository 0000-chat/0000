import type { ProjectionErrorCode } from "@communicator/contracts";

export type { ProjectionErrorCode } from "@communicator/contracts";

export type ProjectionErrorOptions = {
  cause?: unknown;
};

/**
 * Internal projection failures intentionally expose only a stable code and
 * message. Causes remain available for local diagnostics without becoming
 * enumerable or serialized error data.
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
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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

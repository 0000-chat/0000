import type { MiddlewareHandler } from "hono";
import type {
  ActiveIngestionService,
  IngestionDirectoryDatabase,
  IngestionDirectoryResult,
} from "../control-directory/ingestion-repository";
import {
  findActiveIngestionService,
} from "../control-directory/ingestion-repository";
import {
  ingestionError,
  ingestionErrorResponse,
} from "../ingestion/errors";
import { isIngressEnabled } from "../ingestion/config";
import { AuthenticationError, parseBearerToken } from "./bearer";
import {
  OidcVerificationError,
  type TokenVerifier,
} from "./oidc";

export type IngestionAuthorization = {
  service_principal_id: string;
  issuer: string;
  token_id: string;
};

export type IngestionAuthorizationVariables = {
  ingestionAuthorization: IngestionAuthorization;
};

export type IngestionServiceResolver = (
  db: IngestionDirectoryDatabase,
  issuer: string,
  subject: string,
  tokenId: string,
) => Promise<IngestionDirectoryResult<ActiveIngestionService>>;

export type IngestionAuthorizationMiddlewareOptions = {
  getVerifier: (env: Cloudflare.Env) => TokenVerifier;
  resolveService?: IngestionServiceResolver;
};

type IngestionFailureCode =
  | "ingestion_unauthenticated"
  | "ingestion_not_found"
  | "ingestion_unavailable";

function logIngestionAuthorizationFailure(
  status: number,
  code: IngestionFailureCode,
): void {
  console.error({ event: "ingestion_auth_denied", status, code });
}

export function createIngestionAuthorizationMiddleware(
  options: IngestionAuthorizationMiddlewareOptions,
): MiddlewareHandler<{
  Bindings: Cloudflare.Env;
  Variables: IngestionAuthorizationVariables;
}> {
  const resolveService = options.resolveService ?? findActiveIngestionService;

  return async (context, next) => {
    const respond = (
      status: 401 | 404 | 503,
      code: IngestionFailureCode,
    ) => {
      logIngestionAuthorizationFailure(status, code);
      return context.json(
        ingestionErrorResponse(ingestionError(code)),
        status,
      );
    };

    // This gate is intentionally the first operation. In particular, do not
    // parse a bearer token, read a request body, or touch D1 while disabled.
    if (!isIngressEnabled(context.env?.COMMUNICATOR_INGRESS_ENABLED)) {
      return respond(503, "ingestion_unavailable");
    }

    try {
      const token = parseBearerToken(context.req.header("Authorization"));
      const subject = await options.getVerifier(context.env).verify(token);
      if (!subject.token_id) return respond(401, "ingestion_unauthenticated");

      const database = context.env.CONTROL_DB;
      if (!database) return respond(503, "ingestion_unavailable");

      const result = await resolveService(
        database,
        subject.issuer,
        subject.subject,
        subject.token_id,
      );
      if (!result.ok) {
        return result.code === "not_found"
          ? respond(404, "ingestion_not_found")
          : respond(503, "ingestion_unavailable");
      }

      context.set("ingestionAuthorization", {
        service_principal_id: result.value.service_principal_id,
        issuer: result.value.issuer,
        token_id: result.value.token_id,
      });
      await next();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        return respond(401, "ingestion_unauthenticated");
      }
      if (error instanceof OidcVerificationError) {
        return error.code === "invalid"
          ? respond(401, "ingestion_unauthenticated")
          : respond(503, "ingestion_unavailable");
      }
      return respond(503, "ingestion_unavailable");
    }
  };
}

import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  GroupCreateRequestSchema,
  GroupCreateResponseSchema,
  type GroupCreateRequest,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { mapReadError, ReadError, readErrorResponse } from "../read/errors";
import { GroupRepositoryError } from "../groups/repository";
import { createGroup, type GroupRouteServices } from "../groups/service";
import type { ContactServiceContext } from "../contacts/service";

type GroupRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };

export const createGroupRoute = createRoute({
  method: "post",
  path: "/api/v1/groups",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: GroupCreateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Group creation operation",
      content: { "application/json": { schema: GroupCreateResponseSchema } },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    403: { description: "Forbidden", content: errorContent },
    404: { description: "Resource not found", content: errorContent },
    409: { description: "Group operation conflict", content: errorContent },
    503: { description: "Group provider unavailable", content: errorContent },
  },
});

const routeContext = (
  context: Context<GroupRouteEnv>,
): ContactServiceContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

const groupFailure = (error: unknown): ReadError => {
  if (error instanceof GroupRepositoryError) {
    if (error.code === "group_invalid" || error.code === "group_conflict")
      return new ReadError("invalid_request", error);
    if (error.code === "group_not_found")
      return new ReadError("not_found", error);
    return new ReadError("service_unavailable", error);
  }
  return mapReadError(error);
};

export const createGroupHandler = (services: GroupRouteServices = {}) =>
  (async (context) => {
    try {
      const body = context.req.valid("json") as GroupCreateRequest;
      return context.json(
        await createGroup(routeContext(context), body, services),
        200,
      );
    } catch (error) {
      const result = readErrorResponse(groupFailure(error));
      return context.json(result.body, result.status);
    }
  }) satisfies Handler<
    GroupRouteEnv,
    string,
    { out: { json: GroupCreateRequest } }
  >;

import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommunicatorIdSchema,
  GroupManagementEvidenceSchema,
  GroupManagementOperationSchema,
  GroupManagementPageSchema,
  GroupParticipantsRequestSchema,
  GroupRenameRequestSchema,
  type GroupParticipantsRequest,
  type GroupRenameRequest,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { isAdministratorSession } from "../read/authorization";
import { mapReadError, ReadError, readErrorResponse } from "../read/errors";
import {
  addGroupParticipants,
  listManagedGroupOperations,
  listManagementEvidence,
  readManagedGroupOperation,
  removeGroupParticipants,
  renameGroup,
  type GroupManagementRouteServices,
} from "../groups/management-service";

type GroupManagementRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);

const optionalId = z.preprocess(
  (value) => (Array.isArray(value) ? { invalid_query_value: true } : value),
  boundedId.optional(),
);
const optionalCursor = z.preprocess(
  (value) => (Array.isArray(value) ? { invalid_query_value: true } : value),
  z.string().min(1).max(2_048).optional(),
);
const optionalLimit = z.preprocess(
  (value) => (Array.isArray(value) ? { invalid_query_value: true } : value),
  z.coerce.number().int().min(1).max(100).optional(),
);

const managementQuery = z
  .object({
    identity_id: optionalId,
    account_id: optionalId,
    status: z
      .enum(["pending", "succeeded", "failed", "human_action_required"])
      .optional(),
    cursor: optionalCursor,
    limit: optionalLimit,
  })
  .strict();

const mutationResponses = {
  200: {
    description: "Group management operation",
    content: { "application/json": { schema: GroupManagementOperationSchema } },
  },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "Resource not found", content: errorContent },
  409: { description: "Group operation conflict", content: errorContent },
  503: { description: "Group provider unavailable", content: errorContent },
};

export const renameGroupRoute = createRoute({
  method: "patch",
  path: "/api/v1/groups/{conversation_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ conversation_id: boundedId }).strict(),
    body: {
      content: { "application/json": { schema: GroupRenameRequestSchema } },
    },
  },
  responses: mutationResponses,
});

export const addGroupParticipantsRoute = createRoute({
  method: "post",
  path: "/api/v1/groups/{conversation_id}/participants",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ conversation_id: boundedId }).strict(),
    body: {
      content: {
        "application/json": { schema: GroupParticipantsRequestSchema },
      },
    },
  },
  responses: mutationResponses,
});

export const removeGroupParticipantsRoute = createRoute({
  method: "delete",
  path: "/api/v1/groups/{conversation_id}/participants",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ conversation_id: boundedId }).strict(),
    body: {
      content: {
        "application/json": { schema: GroupParticipantsRequestSchema },
      },
    },
  },
  responses: mutationResponses,
});

export const groupManagementOperationsRoute = createRoute({
  method: "get",
  path: "/api/v1/group-management/operations",
  security: [{ bearerAuth: [] }],
  request: { query: managementQuery },
  responses: {
    200: {
      description: "Group management operations",
      content: { "application/json": { schema: GroupManagementPageSchema } },
    },
    401: { description: "Authentication required", content: errorContent },
    400: { description: "Invalid request", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    404: { description: "Resource not found", content: errorContent },
    409: { description: "Group operation conflict", content: errorContent },
    503: { description: "Group directory unavailable", content: errorContent },
  },
});

export const groupManagementOperationEvidenceRoute = createRoute({
  method: "get",
  path: "/api/v1/group-management/operations/{operation_id}/evidence",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ operation_id: boundedId }).strict(),
  },
  responses: {
    200: {
      description: "Provider evidence observations",
      content: {
        "application/json": {
          schema: z.array(GroupManagementEvidenceSchema).max(100),
        },
      },
    },
    401: { description: "Authentication required", content: errorContent },
    400: { description: "Invalid request", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    404: { description: "Operation not found", content: errorContent },
    409: { description: "Group operation conflict", content: errorContent },
    503: { description: "Group directory unavailable", content: errorContent },
  },
});

const routeContext = (
  context: Context<GroupManagementRouteEnv>,
): Parameters<typeof renameGroup>[0] => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

const managementFailure = (error: unknown): ReadError => {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "management_invalid" || code === "management_conflict") {
    return new ReadError("invalid_request", error);
  }
  if (code === "management_not_found") return new ReadError("not_found", error);
  if (code === "management_unavailable")
    return new ReadError("service_unavailable", error);
  return mapReadError(error);
};

const respondWithError = (
  context: Context<GroupManagementRouteEnv>,
  error: unknown,
) => {
  const result = readErrorResponse(managementFailure(error));
  return context.json(result.body, result.status);
};

const matchesPathConversation = (
  conversationId: string,
  body: { conversation_id: string },
): boolean => conversationId === body.conversation_id;

const mutationHandler = async (
  context: Context<GroupManagementRouteEnv>,
  operation: Promise<unknown>,
) => {
  try {
    return context.json(
      GroupManagementOperationSchema.parse(await operation),
      200,
    );
  } catch (error) {
    return respondWithError(context, error);
  }
};

export const createGroupManagementHandlers = (
  services: GroupManagementRouteServices = {},
) => ({
  rename: (async (context) => {
    const body = context.req.valid("json") as GroupRenameRequest;
    const params = context.req.valid("param");
    if (!matchesPathConversation(params.conversation_id, body))
      return respondWithError(context, new ReadError("invalid_request"));
    return mutationHandler(
      context,
      renameGroup(routeContext(context), body, services),
    );
  }) satisfies Handler<
    GroupManagementRouteEnv,
    string,
    { out: { param: { conversation_id: string }; json: GroupRenameRequest } }
  >,
  add: (async (context) => {
    const body = context.req.valid("json") as GroupParticipantsRequest;
    const params = context.req.valid("param");
    if (!matchesPathConversation(params.conversation_id, body))
      return respondWithError(context, new ReadError("invalid_request"));
    return mutationHandler(
      context,
      addGroupParticipants(routeContext(context), body, services),
    );
  }) satisfies Handler<
    GroupManagementRouteEnv,
    string,
    {
      out: {
        param: { conversation_id: string };
        json: GroupParticipantsRequest;
      };
    }
  >,
  remove: (async (context) => {
    const body = context.req.valid("json") as GroupParticipantsRequest;
    const params = context.req.valid("param");
    if (!matchesPathConversation(params.conversation_id, body))
      return respondWithError(context, new ReadError("invalid_request"));
    return mutationHandler(
      context,
      removeGroupParticipants(routeContext(context), body, services),
    );
  }) satisfies Handler<
    GroupManagementRouteEnv,
    string,
    {
      out: {
        param: { conversation_id: string };
        json: GroupParticipantsRequest;
      };
    }
  >,
  operations: (async (context) => {
    if (!isAdministratorSession(context.get("authorization")))
      return respondWithError(context, new ReadError("forbidden"));
    try {
      return context.json(
        await listManagedGroupOperations(
          routeContext(context),
          context.req.valid("query"),
        ),
        200,
      );
    } catch (error) {
      return respondWithError(context, error);
    }
  }) satisfies Handler<
    GroupManagementRouteEnv,
    string,
    {
      out: {
        query: {
          identity_id?: string;
          account_id?: string;
          status?: "pending" | "succeeded" | "failed" | "human_action_required";
          cursor?: string;
          limit?: number;
        };
      };
    }
  >,
  evidence: (async (context) => {
    if (!isAdministratorSession(context.get("authorization")))
      return respondWithError(context, new ReadError("forbidden"));
    try {
      const operationId = context.req.valid("param").operation_id;
      const operation = await readManagedGroupOperation(
        routeContext(context),
        operationId,
      );
      if (operation === null)
        return respondWithError(context, new ReadError("not_found"));
      return context.json(
        await listManagementEvidence(routeContext(context), operationId),
        200,
      );
    } catch (error) {
      return respondWithError(context, error);
    }
  }) satisfies Handler<
    GroupManagementRouteEnv,
    string,
    { out: { param: { operation_id: string } } }
  >,
});

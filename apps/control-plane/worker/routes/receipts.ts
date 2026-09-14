import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommunicatorIdSchema,
  ReadReceiptOperationPageSchema,
  ReadReceiptOperationSchema,
  ReadReceiptRequestSchema,
  ReadReceiptResultSchema,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { mapReadError, ReadError, readErrorResponse } from "../read/errors";
import {
  getReadReceipt,
  listReadReceipts,
  requestReadReceipt,
  type ReceiptServices,
} from "../receipts/service";

type ReceiptRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);
const receiptBody = ReadReceiptRequestSchema.omit({ conversation_id: true });
const receiptPath = z.object({ conversation_id: boundedId }).strict();
const operationPath = z.object({ operation_id: boundedId }).strict();
const receiptQuery = z
  .object({
    account_id: boundedId.optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const receiptErrors = {
  400: { description: "Invalid receipt request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Receipt permission required", content: errorContent },
  404: { description: "Receipt target not found", content: errorContent },
  409: { description: "Receipt operation conflict", content: errorContent },
  503: { description: "Receipt service unavailable", content: errorContent },
};

export const readReceiptRoute = createRoute({
  method: "post",
  path: "/api/v1/conversations/{conversation_id}/receipts/read",
  security: [{ bearerAuth: [] }],
  request: {
    params: receiptPath,
    body: { content: { "application/json": { schema: receiptBody } } },
  },
  responses: {
    200: {
      description: "Read receipt operation state",
      content: { "application/json": { schema: ReadReceiptResultSchema } },
    },
    ...receiptErrors,
  },
});

export const readReceiptOperationRoute = createRoute({
  method: "get",
  path: "/api/v1/receipts/{operation_id}",
  security: [{ bearerAuth: [] }],
  request: { params: operationPath },
  responses: {
    200: {
      description: "Read receipt operation state",
      content: { "application/json": { schema: ReadReceiptOperationSchema } },
    },
    ...receiptErrors,
  },
});

export const readReceiptOperationsRoute = createRoute({
  method: "get",
  path: "/api/v1/receipts",
  security: [{ bearerAuth: [] }],
  request: { query: receiptQuery },
  responses: {
    200: {
      description: "Administrator read receipt operations",
      content: { "application/json": { schema: ReadReceiptOperationPageSchema } },
    },
    ...receiptErrors,
  },
});

const routeContext = (context: Context<ReceiptRouteEnv>) => ({
  env: context.env,
  authorization: context.get("authorization"),
});

const receiptErrorResponse = (
  context: Context<ReceiptRouteEnv>,
  error: unknown,
) => {
  const result = readErrorResponse(mapReadError(error));
  return context.json(result.body, result.status);
};

export const createReceiptHandlers = (services: ReceiptServices = {}) => ({
  create: (async (context) => {
    try {
      const body = context.req.valid("json");
      const params = context.req.valid("param");
      return context.json(
        await requestReadReceipt(
          routeContext(context),
          { ...body, conversation_id: params.conversation_id },
          services,
        ),
        200,
      );
    } catch (error) {
      return receiptErrorResponse(context, error);
    }
  }) satisfies Handler<
    ReceiptRouteEnv,
    string,
    { out: { param: { conversation_id: string }; json: z.infer<typeof receiptBody> } }
  >,
  get: (async (context) => {
    try {
      const params = context.req.valid("param");
      return context.json(
        await getReadReceipt(routeContext(context), params.operation_id),
        200,
      );
    } catch (error) {
      return receiptErrorResponse(context, error);
    }
  }) satisfies Handler<
    ReceiptRouteEnv,
    string,
    { out: { param: { operation_id: string } } }
  >,
  list: (async (context) => {
    try {
      const query = context.req.valid("query");
      return context.json(
        await listReadReceipts(routeContext(context), {
          ...(query.account_id === undefined ? {} : { account_id: query.account_id }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        }),
        200,
      );
    } catch (error) {
      return receiptErrorResponse(context, error);
    }
  }) satisfies Handler<
    ReceiptRouteEnv,
    string,
    { out: { query: z.infer<typeof receiptQuery> } }
  >,
});

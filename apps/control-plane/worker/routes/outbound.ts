import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommandSchema,
  CommunicatorIdSchema,
  TextReplyRequestSchema,
} from "@communicator/contracts";
import { z } from "zod";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  acceptTextReply,
  type OutboundAcceptanceServices,
} from "../outbound/acceptance";
import { readErrorResponse, mapReadError } from "../read/errors";

type OutboundRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);
const TextReplyBodySchema = TextReplyRequestSchema.omit({
  conversation_id: true,
});
type TextReplyBody = z.infer<typeof TextReplyBodySchema>;

export const textReplyRoute = createRoute({
  method: "post",
  path: "/api/v1/conversations/{conversation_id}/messages",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ conversation_id: boundedId }).strict(),
    headers: z
      .object({ "idempotency-key": z.string().trim().min(1).max(200) })
      .passthrough(),
    body: {
      content: { "application/json": { schema: TextReplyBodySchema } },
    },
  },
  responses: {
    202: {
      description: "Text reply durably accepted",
      content: { "application/json": { schema: CommandSchema } },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    403: { description: "Send grant required", content: errorContent },
    404: { description: "Conversation not found", content: errorContent },
    503: {
      description: "Outbound acceptance unavailable",
      content: errorContent,
    },
  },
});

const outboundFailure = (
  context: Context<OutboundRouteEnv>,
  error: unknown,
) => {
  const result = readErrorResponse(mapReadError(error));
  return context.json(result.body, result.status);
};

export const textReplyHandler =
  (
    services: OutboundAcceptanceServices = {},
  ): Handler<
    OutboundRouteEnv,
    string,
    {
      out: {
        param: { conversation_id: string };
        header: { "idempotency-key": string };
        json: TextReplyBody;
      };
    }
  > =>
  async (context) => {
    try {
      const body = context.req.valid("json");
      const params = context.req.valid("param");
      const header = context.req.valid("header");
      const accepted = await acceptTextReply(
        {
          env: context.env,
          authorization: context.get("authorization"),
        },
        {
          ...body,
          conversation_id: params.conversation_id,
        },
        header["idempotency-key"],
        services,
      );
      return context.json(accepted.command, 202);
    } catch (error) {
      return outboundFailure(context, error);
    }
  };

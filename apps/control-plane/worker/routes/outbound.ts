import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommandSchema,
  CommunicatorIdSchema,
  OutboundDecisionResultSchema,
  OutboundEvidenceInputSchema,
  TextReplyRequestSchema,
} from "@communicator/contracts";
import { z } from "zod";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  acceptTextReply,
  decideOutboundCommand,
  listOutboundCommands,
  reconcileOutboundCommand,
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
const DecisionBodySchema = z
  .object({
    idempotency_key: z.string().trim().min(1).max(200),
    duplicate_risk_acknowledged: z.boolean().optional(),
  })
  .strict();
const EvidenceBodySchema = OutboundEvidenceInputSchema;

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

type CommandRouteEnv = OutboundRouteEnv;

const commandPath = z.object({ command_id: boundedId }).strict();

const commandRouteResponse = {
  200: {
    description: "Outbound command lifecycle state",
    content: { "application/json": { schema: OutboundDecisionResultSchema } },
  },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "Command not found", content: errorContent },
  409: { description: "Chat is paused", content: errorContent },
  503: { description: "Projection unavailable", content: errorContent },
};

export const outboundCommandsRoute = createRoute({
  method: "get",
  path: "/api/v1/commands",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Administrator outbound command status",
      content: { "application/json": { schema: CommandSchema.array() } },
    },
    401: { description: "Authentication required", content: errorContent },
    403: {
      description: "Administrator permission required",
      content: errorContent,
    },
    503: { description: "Projection unavailable", content: errorContent },
  },
});

export const reconcileOutboundRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/reconcile",
  security: [{ bearerAuth: [] }],
  request: { params: commandPath },
  responses: commandRouteResponse,
});

export const outboundStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/commands/{command_id}",
  security: [{ bearerAuth: [] }],
  request: { params: commandPath },
  responses: commandRouteResponse,
});

export const outboundEvidenceRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/evidence",
  security: [{ bearerAuth: [] }],
  request: {
    params: commandPath,
    body: { content: { "application/json": { schema: EvidenceBodySchema } } },
  },
  responses: commandRouteResponse,
});

export const confirmOutboundRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/confirm",
  security: [{ bearerAuth: [] }],
  request: {
    params: commandPath,
    body: { content: { "application/json": { schema: DecisionBodySchema } } },
  },
  responses: commandRouteResponse,
});

export const cancelOutboundRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/cancel",
  security: [{ bearerAuth: [] }],
  request: {
    params: commandPath,
    body: { content: { "application/json": { schema: DecisionBodySchema } } },
  },
  responses: commandRouteResponse,
});

export const continueOutboundRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/continue",
  security: [{ bearerAuth: [] }],
  request: {
    params: commandPath,
    body: { content: { "application/json": { schema: DecisionBodySchema } } },
  },
  responses: commandRouteResponse,
});

export const resendOutboundRoute = createRoute({
  method: "post",
  path: "/api/v1/commands/{command_id}/resend",
  security: [{ bearerAuth: [] }],
  request: {
    params: commandPath,
    body: { content: { "application/json": { schema: DecisionBodySchema } } },
  },
  responses: commandRouteResponse,
});

type ReconcileHandler = Handler<
  CommandRouteEnv,
  string,
  {
    out: {
      param: { command_id: string };
      json?: z.infer<typeof EvidenceBodySchema>;
    };
  }
>;

export const reconcileOutboundHandler =
  (services: OutboundAcceptanceServices = {}): ReconcileHandler =>
  async (context) => {
    try {
      const params = context.req.valid("param");
      const result = await reconcileOutboundCommand(
        {
          env: context.env,
          authorization: context.get("authorization"),
        },
        params.command_id,
        services,
      );
      return context.json(result, 200);
    } catch (error) {
      return outboundFailure(context, error);
    }
  };

export const evidenceOutboundHandler =
  (
    services: OutboundAcceptanceServices = {},
  ): Handler<
    CommandRouteEnv,
    string,
    {
      out: {
        param: { command_id: string };
        json: z.infer<typeof EvidenceBodySchema>;
      };
    }
  > =>
  async (context) => {
    try {
      const params = context.req.valid("param");
      const body = context.req.valid("json");
      const result = await reconcileOutboundCommand(
        {
          env: context.env,
          authorization: context.get("authorization"),
        },
        params.command_id,
        services,
        body,
      );
      return context.json(result, 200);
    } catch (error) {
      return outboundFailure(context, error);
    }
  };

export const outboundStatusHandler = reconcileOutboundHandler;

export const outboundCommandsHandler =
  (): Handler<OutboundRouteEnv, string> => async (context) => {
    try {
      const commands = await listOutboundCommands({
        env: context.env,
        authorization: context.get("authorization"),
      });
      return context.json(commands, 200);
    } catch (error) {
      return outboundFailure(context, error);
    }
  };

type DecisionHandler = Handler<
  CommandRouteEnv,
  string,
  {
    out: {
      param: { command_id: string };
      json: {
        idempotency_key: string;
        duplicate_risk_acknowledged?: boolean;
      };
    };
  }
>;

const decisionHandler =
  (
    decision: "confirm" | "cancel" | "continue" | "resend",
    services: OutboundAcceptanceServices = {},
  ) =>
  async (context: Parameters<DecisionHandler>[0]) => {
    try {
      const params = context.req.valid("param");
      const body = context.req.valid("json");
      const result = await decideOutboundCommand(
        {
          env: context.env,
          authorization: context.get("authorization"),
        },
        params.command_id,
        decision,
        body.idempotency_key,
        services,
        body.duplicate_risk_acknowledged,
      );
      return context.json(result, 200);
    } catch (error) {
      return outboundFailure(context, error);
    }
  };

export const confirmOutboundHandler = (
  services: OutboundAcceptanceServices = {},
): DecisionHandler => decisionHandler("confirm", services);

export const cancelOutboundHandler = (
  services: OutboundAcceptanceServices = {},
): DecisionHandler => decisionHandler("cancel", services);

export const continueOutboundHandler = (
  services: OutboundAcceptanceServices = {},
): DecisionHandler => decisionHandler("continue", services);

export const resendOutboundHandler = (
  services: OutboundAcceptanceServices = {},
): DecisionHandler => decisionHandler("resend", services);

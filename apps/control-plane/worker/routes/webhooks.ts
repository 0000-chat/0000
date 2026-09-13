import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommunicatorIdSchema,
  MAX_WEBHOOK_PAGE_SIZE,
  WebhookSubscriptionCreateSchema,
  WebhookSubscriptionCutoverSchema,
  WebhookSubscriptionEvaluationSchema,
  WebhookSubscriptionPageSchema,
  WebhookSubscriptionRevokeSchema,
  WebhookSubscriptionSchema,
  WebhookSubscriptionUpdateSchema,
  type WebhookSubscriptionCreate,
  type WebhookSubscriptionCutover,
  type WebhookSubscriptionRevoke,
  type WebhookSubscriptionUpdate,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  authorizeWebhookInspection,
  createWebhookSubscription,
  cutoverWebhookSubscription,
  evaluateWebhookSubscription,
  listWebhookSubscriptionPage,
  revokeWebhookSubscription,
  updateWebhookSubscription,
  WebhookRepositoryError,
  type WebhookActor,
} from "../control-directory/webhooks";

type WebhookRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);
const optionalCursor = z.string().min(1).max(2_048).optional();
const optionalLimit = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_WEBHOOK_PAGE_SIZE)
  .optional();

const subscriptionResponses = (description: string) => ({
  200: {
    description,
    content: { "application/json": { schema: WebhookSubscriptionSchema } },
  },
  201: {
    description,
    content: { "application/json": { schema: WebhookSubscriptionSchema } },
  },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: {
    description: "Webhook management permission required",
    content: errorContent,
  },
  404: { description: "Subscription not found", content: errorContent },
  409: { description: "Subscription mutation conflict", content: errorContent },
  503: {
    description: "Subscription directory unavailable",
    content: errorContent,
  },
});

export const webhookSubscriptionsRoute = createRoute({
  method: "get",
  path: "/api/v1/webhook-subscriptions",
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({ cursor: optionalCursor, limit: optionalLimit }).strict(),
  },
  responses: {
    200: {
      description: "Webhook subscriptions",
      content: {
        "application/json": { schema: WebhookSubscriptionPageSchema },
      },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    403: {
      description: "Webhook management permission required",
      content: errorContent,
    },
    503: {
      description: "Subscription directory unavailable",
      content: errorContent,
    },
  },
});

export const createWebhookSubscriptionRoute = createRoute({
  method: "post",
  path: "/api/v1/webhook-subscriptions",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: WebhookSubscriptionCreateSchema },
      },
    },
  },
  responses: subscriptionResponses("Created webhook subscription"),
});

export const webhookSubscriptionRoute = createRoute({
  method: "get",
  path: "/api/v1/webhook-subscriptions/{subscription_id}",
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ subscription_id: boundedId }).strict() },
  responses: subscriptionResponses("Webhook subscription"),
});

export const updateWebhookSubscriptionRoute = createRoute({
  method: "patch",
  path: "/api/v1/webhook-subscriptions/{subscription_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ subscription_id: boundedId }).strict(),
    body: {
      content: {
        "application/json": { schema: WebhookSubscriptionUpdateSchema },
      },
    },
  },
  responses: subscriptionResponses("Updated webhook subscription"),
});

export const cutoverWebhookSubscriptionRoute = createRoute({
  method: "post",
  path: "/api/v1/webhook-subscriptions/{subscription_id}/cutover",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ subscription_id: boundedId }).strict(),
    body: {
      content: {
        "application/json": { schema: WebhookSubscriptionCutoverSchema },
      },
    },
  },
  responses: subscriptionResponses("Cut over webhook destination"),
});

export const revokeWebhookSubscriptionRoute = createRoute({
  method: "delete",
  path: "/api/v1/webhook-subscriptions/{subscription_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ subscription_id: boundedId }).strict(),
    body: {
      content: {
        "application/json": {
          schema: WebhookSubscriptionRevokeSchema,
        },
      },
    },
  },
  responses: subscriptionResponses("Revoked webhook subscription"),
});

export const evaluateWebhookSubscriptionRoute = createRoute({
  method: "get",
  path: "/api/v1/webhook-subscriptions/{subscription_id}/evaluate",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ subscription_id: boundedId }).strict(),
    query: z
      .object({
        account_id: boundedId,
        chat_id: boundedId.nullable().optional(),
      })
      .strict(),
  },
  responses: {
    200: {
      description: "Effective webhook setting",
      content: {
        "application/json": { schema: WebhookSubscriptionEvaluationSchema },
      },
    },
    400: { description: "Invalid request", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    403: {
      description: "Webhook management permission required",
      content: errorContent,
    },
    404: { description: "Subscription not found", content: errorContent },
    503: {
      description: "Subscription directory unavailable",
      content: errorContent,
    },
  },
});

const actorFor = (context: Context<WebhookRouteEnv>): WebhookActor => {
  const authorization = context.get("authorization");
  return {
    tenantId: authorization.tenant.id,
    principalId: authorization.principal.id,
    principalType: authorization.principal.type,
    membershipId: authorization.membership.id,
    role: authorization.membership.role,
    identityIds: authorization.identities.map(
      (identity) => identity.identity_id,
    ),
    delegated: context.get("delegated"),
  };
};

const errorResponse = (
  context: Context<WebhookRouteEnv>,
  error: unknown,
): Response => {
  if (error instanceof WebhookRepositoryError) {
    if (error.code === "webhook_invalid")
      return context.json(
        { error: { code: "invalid_request", message: error.message } },
        400,
      );
    if (error.code === "webhook_forbidden")
      return context.json(
        { error: { code: "forbidden", message: error.message } },
        403,
      );
    if (error.code === "webhook_not_found")
      return context.json(
        { error: { code: "not_found", message: error.message } },
        404,
      );
    if (error.code === "webhook_conflict")
      return context.json(
        { error: { code: "invalid_request", message: error.message } },
        409,
      );
  }
  return context.json(
    {
      error: {
        code: "service_unavailable",
        message: "Webhook subscription directory unavailable",
      },
    },
    503,
  );
};

const now = (): string => new Date().toISOString();

export const webhookSubscriptionsHandler: Handler<
  WebhookRouteEnv,
  string,
  { out: { query: { cursor?: string; limit?: number } } }
> = async (context) => {
  try {
    const query = context.req.valid("query");
    return context.json(
      await listWebhookSubscriptionPage(
        context.env.CONTROL_DB.withSession("first-primary"),
        actorFor(context),
        query.cursor,
        query.limit,
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const createWebhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  { out: { json: WebhookSubscriptionCreate } }
> = async (context) => {
  try {
    return context.json(
      await createWebhookSubscription(
        context.env.CONTROL_DB,
        actorFor(context),
        context.req.valid("json"),
        now(),
      ),
      201,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const webhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  { out: { param: { subscription_id: string } } }
> = async (context) => {
  try {
    return context.json(
      await authorizeWebhookInspection(
        context.env.CONTROL_DB.withSession("first-primary"),
        actorFor(context),
        context.req.valid("param").subscription_id,
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const updateWebhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  {
    out: {
      param: { subscription_id: string };
      json: WebhookSubscriptionUpdate;
    };
  }
> = async (context) => {
  try {
    const input = context.req.valid("json");
    return context.json(
      await updateWebhookSubscription(
        context.env.CONTROL_DB,
        actorFor(context),
        context.req.valid("param").subscription_id,
        input,
        now(),
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const cutoverWebhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  {
    out: {
      param: { subscription_id: string };
      json: WebhookSubscriptionCutover;
    };
  }
> = async (context) => {
  try {
    const input = context.req.valid("json");
    return context.json(
      await cutoverWebhookSubscription(
        context.env.CONTROL_DB,
        actorFor(context),
        context.req.valid("param").subscription_id,
        input.destination,
        input.idempotency_key,
        now(),
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const revokeWebhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  {
    out: {
      param: { subscription_id: string };
      json: WebhookSubscriptionRevoke;
    };
  }
> = async (context) => {
  try {
    const input = context.req.valid("json");
    return context.json(
      await revokeWebhookSubscription(
        context.env.CONTROL_DB,
        actorFor(context),
        context.req.valid("param").subscription_id,
        input.idempotency_key,
        now(),
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

export const evaluateWebhookSubscriptionHandler: Handler<
  WebhookRouteEnv,
  string,
  {
    out: {
      param: { subscription_id: string };
      query: { account_id: string; chat_id?: string | null };
    };
  }
> = async (context) => {
  try {
    const subscription = await authorizeWebhookInspection(
      context.env.CONTROL_DB.withSession("first-primary"),
      actorFor(context),
      context.req.valid("param").subscription_id,
    );
    const query = context.req.valid("query");
    return context.json(
      await evaluateWebhookSubscription(
        context.env.CONTROL_DB.withSession("first-primary"),
        subscription.tenant_id,
        subscription.id,
        query.account_id,
        query.chat_id ?? null,
      ),
      200,
    );
  } catch (error) {
    return errorResponse(context, error);
  }
};

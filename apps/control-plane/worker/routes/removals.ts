import { createRoute } from "@hono/zod-openapi";
import { ApiErrorResponseSchema } from "@communicator/contracts";
import {
  RecordRemovalInputSchema,
  RemovalAuthoritySchema,
  RemovalStatusResponseSchema,
  ScheduleRemovalExpiryInputSchema,
  RemovalExpiryScheduleSchema,
  type RecordRemovalInput,
  type ScheduleRemovalExpiryInput,
} from "../../../../packages/contracts/src/removals";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { isAdministratorSession } from "../read/authorization";
import {
  recordRemovalWithSuppression,
  removalStatusForTenant,
} from "../removals/service";
import { scheduleRemovalExpiry } from "../removals/ledger";

type RemovalRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const removalErrors = {
  400: { description: "Invalid removal request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: {
    description: "Administrator permission required",
    content: errorContent,
  },
  503: { description: "Removal authority unavailable", content: errorContent },
};

export const removalStatusRoute = createRoute({
  method: "get",
  path: "/api/v1/removals",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Removal authority and incomplete active-removal work",
      content: { "application/json": { schema: RemovalStatusResponseSchema } },
    },
    ...removalErrors,
  },
});

export const recordRemovalRoute = createRoute({
  method: "post",
  path: "/api/v1/removals",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: RecordRemovalInputSchema } },
    },
  },
  responses: {
    201: {
      description: "Removal authority recorded before active suppression",
      content: { "application/json": { schema: RemovalAuthoritySchema } },
    },
    ...removalErrors,
  },
});

export const scheduleRemovalExpiryRoute = createRoute({
  method: "post",
  path: "/api/v1/removal-expiries",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: ScheduleRemovalExpiryInputSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Durable removal expiry wakeup scheduled",
      content: { "application/json": { schema: RemovalExpiryScheduleSchema } },
    },
    ...removalErrors,
  },
});

const isAdministrator = (context: Context<RemovalRouteEnv>): boolean =>
  isAdministratorSession(context.get("authorization"));

const forbidden = (context: Context<RemovalRouteEnv>): Response =>
  context.json(
    {
      error: {
        code: "forbidden",
        message: "Administrator permission required",
      },
    },
    403,
  );

const unavailable = (
  context: Context<RemovalRouteEnv>,
  error: unknown,
): Response => {
  console.error({
    event: "removal_authority_route_error",
    error: error instanceof Error ? error.name : "unknown",
  });
  return context.json(
    {
      error: {
        code: "service_unavailable",
        message: "Removal authority unavailable",
      },
    },
    503,
  );
};

export const removalStatusHandler: Handler<RemovalRouteEnv> = async (
  context,
) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    return context.json(
      await removalStatusForTenant(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
      ),
      200,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

export const recordRemovalHandler: Handler<
  RemovalRouteEnv,
  string,
  { out: { json: RecordRemovalInput } }
> = async (context) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    const input = context.req.valid("json");
    const tenantId = context.get("authorization").tenant.id;
    if (input.tenant_id !== tenantId) return forbidden(context);
    return context.json(
      await recordRemovalWithSuppression(context.env.CONTROL_DB, input),
      201,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

export const scheduleRemovalExpiryHandler: Handler<
  RemovalRouteEnv,
  string,
  { out: { json: ScheduleRemovalExpiryInput } }
> = async (context) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    const input = context.req.valid("json");
    const tenantId = context.get("authorization").tenant.id;
    if (input.tenant_id !== tenantId) return forbidden(context);
    return context.json(
      await scheduleRemovalExpiry(context.env.CONTROL_DB, input),
      201,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

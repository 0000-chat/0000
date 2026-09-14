import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  CommunicatorIdSchema,
  RestoreActivationLeaseReleaseSchema,
  RestoreActivationLeaseSchema,
  RestoreAuthorityExportSchema,
  RestoreProjectionActivationResultSchema,
  TimestampSchema,
} from "@communicator/contracts";
import { z } from "zod";
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
import { recordRemovalWithArchivePurge } from "../archive/lifecycle";
import { removalStatusForTenant } from "../removals/service";
import { scheduleRemovalExpiry } from "../removals/ledger";
import { createConfiguredControlledCopyAdapters } from "../retention";
import { createRestoreAuthorityExport } from "../restore/authority";
import { restoreTenantProjectionFromArchive } from "../restore/activation";
import {
  acquireRestoreActivationLease,
  releaseRestoreActivationLease,
} from "../restore/lease";

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

export const restoreAuthorityRoute = createRoute({
  method: "get",
  path: "/api/v1/removals/restore-authority",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Current removal authority and restore evidence",
      content: {
        "application/json": { schema: RestoreAuthorityExportSchema },
      },
    },
    ...removalErrors,
  },
});

const RestoreProjectionActivationInputSchema = z
  .object({
    rebuild_id: CommunicatorIdSchema,
    expected_generation: z.number().int().safe().positive(),
    started_at: TimestampSchema,
  })
  .strict();

type RestoreProjectionActivationInput = z.infer<
  typeof RestoreProjectionActivationInputSchema
>;

export const restoreProjectionActivationRoute = createRoute({
  method: "post",
  path: "/api/v1/removals/restore-projection",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: RestoreProjectionActivationInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Projection rebuilt from sanitized archive after the current removal authority was applied",
      content: {
        "application/json": {
          schema: RestoreProjectionActivationResultSchema,
        },
      },
    },
    ...removalErrors,
  },
});

const RestoreActivationLeaseInputSchema = z
  .object({
    lease_id: CommunicatorIdSchema,
    expected_deletion_epoch: z.number().int().safe().nonnegative(),
    expected_ledger_head: z.string().trim().min(1).max(256),
    ttl_seconds: z.number().int().safe().min(1).max(900).default(600),
  })
  .strict();

type RestoreActivationLeaseInput = z.infer<
  typeof RestoreActivationLeaseInputSchema
>;

const RestoreActivationLeaseReleaseInputSchema = z
  .object({
    lease_id: CommunicatorIdSchema,
    lease_token: z.string().trim().min(32).max(256),
  })
  .strict();

type RestoreActivationLeaseReleaseInput = z.infer<
  typeof RestoreActivationLeaseReleaseInputSchema
>;

export const restoreActivationLeaseRoute = createRoute({
  method: "post",
  path: "/api/v1/removals/restore-activation-lease",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: RestoreActivationLeaseInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Acquire the restore write fence at the current authority head",
      content: { "application/json": { schema: RestoreActivationLeaseSchema } },
    },
    ...removalErrors,
  },
});

export const restoreActivationLeaseReleaseRoute = createRoute({
  method: "post",
  path: "/api/v1/removals/restore-activation-lease/release",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: RestoreActivationLeaseReleaseInputSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Release the restore write fence after service readiness",
      content: {
        "application/json": {
          schema: RestoreActivationLeaseReleaseSchema,
        },
      },
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

export const restoreAuthorityHandler: Handler<RemovalRouteEnv> = async (
  context,
) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    return context.json(
      await createRestoreAuthorityExport(
        context.env.CONTROL_DB,
        context.get("authorization").tenant.id,
        new Date(),
        createConfiguredControlledCopyAdapters(
          context.env as unknown as Record<string, unknown>,
        ),
      ),
      200,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

export const restoreProjectionActivationHandler: Handler<
  RemovalRouteEnv,
  string,
  { out: { json: RestoreProjectionActivationInput } }
> = async (context) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    const input = context.req.valid("json");
    const authorization = context.get("authorization");
    const completedAt = new Date().toISOString();
    return context.json(
      await restoreTenantProjectionFromArchive({
        env: context.env,
        tenantId: authorization.tenant.id,
        principalId: authorization.principal.id,
        rebuildId: input.rebuild_id,
        expectedGeneration: input.expected_generation,
        startedAt: input.started_at,
        completedAt,
        now: new Date(completedAt),
      }),
      200,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

export const restoreActivationLeaseHandler: Handler<
  RemovalRouteEnv,
  string,
  { out: { json: RestoreActivationLeaseInput } }
> = async (context) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    const input = context.req.valid("json");
    const authorization = context.get("authorization");
    const current = await createRestoreAuthorityExport(
      context.env.CONTROL_DB,
      authorization.tenant.id,
      new Date(),
      createConfiguredControlledCopyAdapters(
        context.env as unknown as Record<string, unknown>,
      ),
    );
    if (
      current.deletion_epoch !== input.expected_deletion_epoch ||
      current.ledger_head !== input.expected_ledger_head
    ) {
      throw new Error("restore authority changed before activation lease");
    }
    return context.json(
      await acquireRestoreActivationLease(context.env.CONTROL_DB, {
        tenantId: authorization.tenant.id,
        leaseId: input.lease_id,
        expectedDeletionEpoch: input.expected_deletion_epoch,
        expectedLedgerHead: input.expected_ledger_head,
        ttlMs: input.ttl_seconds * 1_000,
      }),
      200,
    );
  } catch (error) {
    return unavailable(context, error);
  }
};

export const restoreActivationLeaseReleaseHandler: Handler<
  RemovalRouteEnv,
  string,
  { out: { json: RestoreActivationLeaseReleaseInput } }
> = async (context) => {
  if (!isAdministrator(context)) return forbidden(context);
  try {
    const input = context.req.valid("json");
    const authorization = context.get("authorization");
    const released = await releaseRestoreActivationLease(
      context.env.CONTROL_DB,
      {
        tenantId: authorization.tenant.id,
        leaseId: input.lease_id,
        leaseToken: input.lease_token,
      },
    );
    return context.json(
      RestoreActivationLeaseReleaseSchema.parse({
        released,
        lease_id: input.lease_id,
      }),
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
    const result = await recordRemovalWithArchivePurge(
      {
        database: context.env.CONTROL_DB,
        bucket: context.env.EVENT_ARCHIVE,
        retentionAdapters: createConfiguredControlledCopyAdapters(
          context.env as unknown as Record<string, unknown>,
        ),
      },
      input,
    );
    return context.json(result.authority, 201);
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

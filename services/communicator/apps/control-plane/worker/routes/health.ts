import { createRoute, z } from "@hono/zod-openapi";

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.literal("communicator-control-plane"),
    data_mode: z.enum(["unconfigured", "simulated", "live"]),
  })
  .strict();

export const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  responses: {
    200: {
      description: "Control-plane liveness and configured data mode",
      content: {
        "application/json": { schema: HealthResponseSchema },
      },
    },
  },
});

import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  SessionResponseSchema,
} from "@communicator/contracts";

const errorContent = {
  "application/json": { schema: ApiErrorResponseSchema },
};

export const sessionRoute = createRoute({
  method: "get",
  path: "/api/v1/session",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description:
        "Authenticated tenant, principal, and identity authorization",
      content: { "application/json": { schema: SessionResponseSchema } },
    },
    400: { description: "Tenant selection required", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    404: { description: "Authorized tenant not found", content: errorContent },
    503: {
      description: "Authorization service unavailable",
      content: errorContent,
    },
  },
});

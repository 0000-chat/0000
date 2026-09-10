import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  RealtimeTicketRequestSchema,
  RealtimeTicketResponseSchema,
} from "@communicator/contracts";

const errorContent = {
  "application/json": { schema: ApiErrorResponseSchema },
};

export const realtimeTicketRoute = createRoute({
  method: "post",
  path: "/api/v1/realtime/tickets",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: RealtimeTicketRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: "A single-use realtime WebSocket ticket",
      content: { "application/json": { schema: RealtimeTicketResponseSchema } },
    },
    400: { description: "Invalid realtime ticket request", content: errorContent },
    401: { description: "Authentication required", content: errorContent },
    404: { description: "Realtime authorization not found", content: errorContent },
    503: { description: "Realtime ticket service unavailable", content: errorContent },
  },
});

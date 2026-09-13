import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  ContactResolutionSchema,
  ContactSearchPageSchema,
  ContactResolveRequestSchema,
  CreateDirectChatRequestSchema,
  DirectChatSchema,
  CommunicatorIdSchema,
  type ContactSearchRequest,
  type ContactResolveRequest,
  type CreateDirectChatRequest,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { readErrorResponse, mapReadError, ReadError } from "../read/errors";
import { ContactRepositoryError } from "../contacts/repository";
import {
  createDirectChat,
  resolveContact,
  searchContacts,
  type ContactRouteServices,
  type ContactServiceContext,
} from "../contacts/service";

type ContactRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

const errorContent = { "application/json": { schema: ApiErrorResponseSchema } };
const boundedId = CommunicatorIdSchema.max(128);

const contactSearchQuery = z
  .object({
    identity_id: boundedId,
    account_id: boundedId,
    query: z.string().trim().min(1).max(200),
  })
  .strict();

const contactResponses = (schema: z.ZodTypeAny, description: string) => ({
  200: { description, content: { "application/json": { schema } } },
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "Resource not found", content: errorContent },
  409: { description: "Operation state conflict", content: errorContent },
  503: { description: "Contact provider unavailable", content: errorContent },
});

export const contactsRoute = createRoute({
  method: "get",
  path: "/api/v1/contacts",
  security: [{ bearerAuth: [] }],
  request: { query: contactSearchQuery },
  responses: contactResponses(ContactSearchPageSchema, "Account contacts"),
});

export const resolveContactRoute = createRoute({
  method: "post",
  path: "/api/v1/contacts/resolve",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "application/json": { schema: ContactResolveRequestSchema } },
    },
  },
  responses: contactResponses(
    ContactResolutionSchema,
    "Resolved account contact",
  ),
});

export const createDirectChatRoute = createRoute({
  method: "post",
  path: "/api/v1/conversations",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": { schema: CreateDirectChatRequestSchema },
      },
    },
  },
  responses: {
    ...contactResponses(DirectChatSchema, "Created direct conversation"),
    201: {
      description: "Created direct conversation",
      content: { "application/json": { schema: DirectChatSchema } },
    },
  },
});

const routeContext = (
  context: Context<ContactRouteEnv>,
): ContactServiceContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  delegated: context.get("delegated"),
});

const contactFailure = (error: unknown): ReadError => {
  if (error instanceof ContactRepositoryError) {
    if (error.code === "contact_invalid" || error.code === "contact_conflict")
      return new ReadError("invalid_request", error);
    if (error.code === "contact_not_found")
      return new ReadError("not_found", error);
    return new ReadError("service_unavailable", error);
  }
  return mapReadError(error);
};

const contactErrorResponse = (
  context: Context<ContactRouteEnv>,
  error: unknown,
) => {
  const result = readErrorResponse(contactFailure(error));
  return context.json(result.body, result.status);
};

export const createContactHandlers = (services: ContactRouteServices = {}) => ({
  contacts: (async (context) => {
    try {
      const query = context.req.valid("query") as ContactSearchRequest;
      return context.json(
        await searchContacts(routeContext(context), query, services),
        200,
      );
    } catch (error) {
      return contactErrorResponse(context, error);
    }
  }) satisfies Handler<
    ContactRouteEnv,
    string,
    { out: { query: ContactSearchRequest } }
  >,
  resolve: (async (context) => {
    try {
      const body = context.req.valid("json") as ContactResolveRequest;
      return context.json(
        await resolveContact(routeContext(context), body, services),
        200,
      );
    } catch (error) {
      return contactErrorResponse(context, error);
    }
  }) satisfies Handler<
    ContactRouteEnv,
    string,
    { out: { json: ContactResolveRequest } }
  >,
  create: (async (context) => {
    try {
      const body = context.req.valid("json") as CreateDirectChatRequest;
      return context.json(
        await createDirectChat(routeContext(context), body, services),
        200,
      );
    } catch (error) {
      return contactErrorResponse(context, error);
    }
  }) satisfies Handler<
    ContactRouteEnv,
    string,
    { out: { json: CreateDirectChatRequest } }
  >,
});

import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiErrorResponseSchema,
  AttachmentMetadataSchema,
  CommunicatorIdSchema,
} from "@communicator/contracts";
import type { Context, Handler } from "hono";
import type { AuthorizationVariables } from "../auth/middleware";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import {
  attachmentErrorBody,
  AttachmentServiceError,
  downloadAttachment,
  getAttachmentMetadata,
  type AttachmentServiceContext,
} from "./service";
import { attachmentProviderFromEnv } from "./provider";

type AttachmentRouteEnv = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables & IngestionAuthorizationVariables;
};

export type AttachmentRouteServices = {
  createProvider?: typeof attachmentProviderFromEnv;
  now?: () => Date;
};

const errorContent = {
  "application/json": { schema: ApiErrorResponseSchema },
};
const boundedId = CommunicatorIdSchema.max(128);
const singleValue = (schema: z.ZodTypeAny) =>
  z.preprocess((value) => (Array.isArray(value) ? undefined : value), schema);

const metadataQuery = z
  .object({
    identity_id: singleValue(boundedId),
    account_id: singleValue(boundedId.optional()),
  })
  .strict();

const grantQuery = z
  .object({
    download_grant: singleValue(z.string().min(1).max(512).optional()),
  })
  .strict();

const grantHeaders = z
  .object({
    "x-communicator-download-grant": z.string().min(1).max(512).optional(),
  })
  .passthrough();

const attachmentPath = z.object({ attachment_id: boundedId }).strict();

const attachmentResponses = {
  400: { description: "Invalid request", content: errorContent },
  401: { description: "Authentication required", content: errorContent },
  403: { description: "Forbidden", content: errorContent },
  404: { description: "Attachment not found", content: errorContent },
  409: { description: "Attachment revision changed", content: errorContent },
  410: {
    description: "Attachment unavailable or removed",
    content: errorContent,
  },
  503: { description: "Attachment service unavailable", content: errorContent },
};

export const attachmentMetadataRoute = createRoute({
  method: "get",
  path: "/api/v1/attachments/{attachment_id}",
  security: [{ bearerAuth: [] }],
  request: {
    params: attachmentPath,
    query: metadataQuery,
  },
  responses: {
    200: {
      description: "Authorized incoming attachment metadata",
      content: { "application/json": { schema: AttachmentMetadataSchema } },
    },
    ...attachmentResponses,
  },
});

export const attachmentDownloadRoute = createRoute({
  method: "get",
  path: "/api/v1/attachments/{attachment_id}/download",
  security: [{ bearerAuth: [] }],
  request: {
    params: attachmentPath,
    query: grantQuery,
    headers: grantHeaders,
  },
  responses: {
    200: {
      description: "Authorized bounded attachment bytes",
      content: { "application/octet-stream": { schema: z.any() } },
    },
    ...attachmentResponses,
  },
});

const serviceContext = (
  context: Context<AttachmentRouteEnv>,
  services: AttachmentRouteServices,
  requestedIdentityId?: string,
): AttachmentServiceContext => ({
  env: context.env,
  authorization: context.get("authorization"),
  ...(requestedIdentityId === undefined ? {} : { requestedIdentityId }),
  delegated: context.get("delegated"),
  provider: (services.createProvider ?? attachmentProviderFromEnv)(context.env),
  ...(services.now === undefined ? {} : { now: services.now }),
});

const errorResponse = (
  context: Context<AttachmentRouteEnv>,
  error: unknown,
) => {
  if (error instanceof AttachmentServiceError) {
    return context.json(attachmentErrorBody(error), error.status);
  }
  const unavailable = new AttachmentServiceError("service_unavailable", 503);
  return context.json(attachmentErrorBody(unavailable), 503);
};

export const createAttachmentHandlers = (
  services: AttachmentRouteServices = {},
) => ({
  metadata: (async (context) => {
    try {
      const path = context.req.valid("param");
      const query = context.req.valid("query");
      return context.json(
        await getAttachmentMetadata(
          serviceContext(context, services, query.identity_id),
          {
            attachment_id: path.attachment_id,
            identity_id: query.identity_id,
            ...(query.account_id === undefined
              ? {}
              : { account_id: query.account_id }),
          },
        ),
        200,
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  }) satisfies Handler<
    AttachmentRouteEnv,
    string,
    {
      out: {
        param: { attachment_id: string };
        query: { identity_id: string; account_id?: string };
      };
    }
  >,
  download: (async (context) => {
    try {
      const path = context.req.valid("param");
      const query = context.req.valid("query");
      const headers = context.req.valid("header");
      const token =
        query.download_grant ?? headers["x-communicator-download-grant"];
      return await downloadAttachment(
        serviceContext(context, services),
        token,
        path.attachment_id,
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  }) satisfies Handler<
    AttachmentRouteEnv,
    string,
    {
      out: {
        param: { attachment_id: string };
        query: { download_grant?: string };
        header: { "x-communicator-download-grant"?: string };
      };
    }
  >,
});

import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CommunicatorIdSchema,
  MAX_ATTACHMENT_BYTES,
} from "@communicator/contracts";
import { z } from "zod/v4";
import type { ReadHandlerContext } from "../read/handlers";
import { attachmentProviderFromEnv } from "./provider";
import type { AttachmentRouteServices } from "./routes";
import {
  attachmentErrorBody,
  AttachmentServiceError,
  downloadAttachment,
  getAttachmentMetadata,
} from "./service";

export function registerAttachmentMcpTools(
  server: McpServer,
  context: ReadHandlerContext,
  services: AttachmentRouteServices,
): void {
  const serviceContext = () => ({
    env: context.env,
    authorization: context.authorization,
    ...(context.delegated === undefined
      ? {}
      : { delegated: context.delegated }),
    provider: (services.createProvider ?? attachmentProviderFromEnv)(
      context.env,
    ),
    ...(services.now === undefined ? {} : { now: services.now }),
  });
  const withErrors = async (
    read: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    try {
      return await read();
    } catch (error) {
      const failure =
        error instanceof AttachmentServiceError
          ? error
          : new AttachmentServiceError("service_unavailable", 503);
      return {
        isError: true,
        content: [
          { type: "text", text: JSON.stringify(attachmentErrorBody(failure)) },
        ],
      };
    }
  };
  const id = CommunicatorIdSchema.max(128);
  server.registerTool(
    "get_attachment",
    {
      description:
        "Read authorized attachment metadata and a short-lived download grant; metadata does not retrieve file bytes",
      inputSchema: z
        .object({
          attachment_id: id,
          identity_id: id,
          account_id: id.optional(),
        })
        .strict(),
    },
    (input) =>
      withErrors(async () => {
        const metadata = await getAttachmentMetadata(serviceContext(), {
          attachment_id: input.attachment_id,
          identity_id: input.identity_id,
          ...(input.account_id === undefined
            ? {}
            : { account_id: input.account_id }),
        });
        return {
          structuredContent: metadata,
          content: [{ type: "text", text: JSON.stringify(metadata) }],
        };
      }),
  );
  server.registerTool(
    "download_attachment",
    {
      description:
        "Retrieve authenticated, revalidated attachment bytes as an embedded base64 blob, bounded to 8 MiB before encoding; no external-client compatibility is implied",
      inputSchema: z
        .object({
          attachment_id: id,
          download_grant: z.string().min(32).max(512),
        })
        .strict(),
    },
    (input) =>
      withErrors(async () => {
        const response = await downloadAttachment(
          serviceContext(),
          input.download_grant,
          input.attachment_id,
        );
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          throw new AttachmentServiceError("attachment_unavailable", 410);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `communicator:attachment/${input.attachment_id}`,
                mimeType:
                  response.headers.get("content-type") ??
                  "application/octet-stream",
                blob: Buffer.from(bytes).toString("base64"),
              },
            },
          ],
        };
      }),
  );
}

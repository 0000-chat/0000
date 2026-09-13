import { z } from "zod";
import { CommunicatorIdSchema, TimestampSchema } from "./ids";

/**
 * Attachment bytes are deliberately bounded at the application boundary.
 * Providers may retain larger media, but a single agent read must never turn
 * into an unbounded Worker response or gateway request.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_COUNT = 100;
export const ATTACHMENT_DOWNLOAD_GRANT_TTL_MS = 5 * 60 * 1000;

export const AttachmentAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "removed",
  "expired",
]);
export type AttachmentAvailability = z.infer<
  typeof AttachmentAvailabilitySchema
>;

const AttachmentMetadataObjectSchema = z
  .object({
    attachment_id: CommunicatorIdSchema,
    message_id: CommunicatorIdSchema,
    mime_type: z.string().min(1).max(255).nullable(),
    file_name: z.string().max(512).nullable(),
    size_bytes: z.number().int().safe().nonnegative().nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .nullable(),
    /** The current message/attachment projection revision. */
    revision: z.string().min(1).max(1_024),
    availability: AttachmentAvailabilitySchema,
    download_grant: z.string().min(32).max(512).nullable(),
    download_grant_expires_at: TimestampSchema.nullable(),
  })
  .strict();

export const AttachmentMetadataSchema = z.preprocess((input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input;
}, AttachmentMetadataObjectSchema);

export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>;

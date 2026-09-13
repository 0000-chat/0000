import {
  MAX_REALTIME_ATTACHMENT_JSON_BYTES,
  MAX_REALTIME_IDENTITIES,
  RealtimePositionSchema,
  RealtimeResumePositionSchema,
  RealtimeSubscriptionSchema,
} from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import {
  RealtimeSocketAttachmentSchema,
  RealtimeUpgradeContextSchema,
  assertRealtimeAttachmentSize,
  parseRealtimeAttachment,
  parseRealtimeUpgradeContext,
  realtimeAttachmentJsonBytes,
  serializeRealtimeAttachment,
} from "../../realtime/contracts";

const baseContext = {
  schema_version: 1,
  tenant_id: "tenant_pilot",
  principal_id: "principal_human",
  membership_id: "membership_human",
  subscriptions: [{ identity_id: "identity_human", families: ["projection"] }],
  resume: [{ identity_id: "identity_human", generation: 1, after_sequence: 42 }],
  issued_at: "2026-09-10T10:00:00.000Z",
  expires_at: "2026-09-10T10:00:30.000Z",
};

const baseAttachment = {
  schema_version: 1,
  tenant_id: "tenant_pilot",
  principal_id: "principal_human",
  subscriptions: [{ identity_id: "identity_human", families: ["projection"] }],
  positions: [{ identity_id: "identity_human", generation: 1, sequence: 42 }],
  lease_expires_at: "2026-09-10T10:15:00.000Z",
  resumed: true,
};

const maxId = (prefix: string, index: number): string => {
  const suffix = `${String(index).padStart(3, "0")}_${"x".repeat(240)}`;
  return `${prefix}_${suffix}`.slice(0, 255);
};

const largestAttachment = {
  ...baseAttachment,
  tenant_id: `tenant_${"t".repeat(248)}`,
  principal_id: `principal_${"p".repeat(245)}`,
  subscriptions: Array.from({ length: MAX_REALTIME_IDENTITIES }, (_, index) => ({
    identity_id: maxId("identity", index),
    families: ["projection"],
  })),
  positions: Array.from({ length: MAX_REALTIME_IDENTITIES }, (_, index) => ({
    identity_id: maxId("identity", index),
    generation: 1,
    sequence: 42,
  })),
};

describe("internal realtime contracts", () => {
  it("accepts only the server-generated upgrade context shape", () => {
    expect(RealtimeUpgradeContextSchema.parse(baseContext)).toEqual(baseContext);
    expect(RealtimeSubscriptionSchema.parse(baseContext.subscriptions[0])).toEqual(
      baseContext.subscriptions[0],
    );
    expect(RealtimeResumePositionSchema.parse(baseContext.resume[0])).toEqual(
      baseContext.resume[0],
    );

    for (const forbidden of [
      { ticket: "rt1_secret" },
      { headers: { authorization: "Bearer secret" } },
      { credentials: { access: "secret" } },
      { message_data: "message body" },
      { label: "participant label" },
      { matrix_id: "!room:example" },
      { remote_id: "remote-secret" },
      { metadata: { arbitrary: true } },
    ]) {
      expect(RealtimeUpgradeContextSchema.safeParse({ ...baseContext, ...forbidden }).success).toBe(false);
    }
  });

  it("bounds every internal identity-bearing ID and subscription count", () => {
    for (const field of ["tenant_id", "principal_id", "membership_id"] as const) {
      expect(RealtimeUpgradeContextSchema.safeParse({
        ...baseContext,
        [field]: `${field}_${"x".repeat(248)}`,
      }).success).toBe(false);
    }
    expect(RealtimeUpgradeContextSchema.safeParse({
      ...baseContext,
      subscriptions: [{
        identity_id: `identity_${"x".repeat(247)}`,
        families: ["projection"],
      }],
    }).success).toBe(false);
    expect(RealtimeUpgradeContextSchema.safeParse({
      ...baseContext,
      subscriptions: Array.from({ length: MAX_REALTIME_IDENTITIES + 1 }, (_, index) => ({
        identity_id: `identity_${String(index).padStart(2, "0")}`,
        families: ["projection"],
      })),
      resume: [],
    }).success).toBe(false);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      positions: [{ identity_id: "identity_human", generation: 0, sequence: 0 }],
    }).success).toBe(false);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      positions: [baseAttachment.positions[0], baseAttachment.positions[0]],
    }).success).toBe(false);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      positions: [{ identity_id: "identity_other", generation: 1, sequence: 42 }],
    }).success).toBe(false);
    expect(RealtimePositionSchema.safeParse({
      identity_id: "identity_human",
      generation: 1,
      sequence: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
  });

  it("requires one position for every subscribed identity", () => {
    const subscriptions = [
      ...baseAttachment.subscriptions,
      { identity_id: "identity_agent", families: ["projection"] },
    ];

    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      subscriptions,
      positions: [baseAttachment.positions[0]],
    }).success).toBe(false);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      subscriptions,
      positions: [
        baseAttachment.positions[0],
        { identity_id: "identity_agent", generation: 1, sequence: 42 },
      ],
    }).success).toBe(true);
  });

  it("accepts a largest schema-valid attachment below the JSON guard", () => {
    const parsed = RealtimeSocketAttachmentSchema.parse(largestAttachment);
    expect(realtimeAttachmentJsonBytes(parsed)).toBeLessThan(MAX_REALTIME_ATTACHMENT_JSON_BYTES);
    expect(serializeRealtimeAttachment(parsed)).toEqual(parsed);
    expect(() => structuredClone(parsed)).not.toThrow();
  });

  it("rejects oversized JSON before an attachment can be serialized", () => {
    const rejectedValue = "attachment-value-must-not-appear-in-errors";
    const oversized = { value: `${rejectedValue}${"x".repeat(MAX_REALTIME_ATTACHMENT_JSON_BYTES)}` };
    let failure: unknown;
    try {
      assertRealtimeAttachmentSize(oversized);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(rejectedValue);
    expect(JSON.stringify(failure)).not.toContain(rejectedValue);
  });

  it("uses strict safe parsers that do not reflect rejected context or attachment values", () => {
    const contextSecret = "context-secret-must-not-be-reflected";
    const attachmentSecret = "attachment-secret-must-not-be-reflected";
    let contextFailure: unknown;
    try {
      parseRealtimeUpgradeContext({ ...baseContext, tenant_id: contextSecret });
    } catch (error) {
      contextFailure = error;
    }
    let attachmentFailure: unknown;
    try {
      parseRealtimeAttachment({ ...baseAttachment, tenant_id: attachmentSecret });
    } catch (error) {
      attachmentFailure = error;
    }

    expect(contextFailure).toBeInstanceOf(Error);
    expect(attachmentFailure).toBeInstanceOf(Error);
    expect(String(contextFailure)).not.toContain(contextSecret);
    expect(String(attachmentFailure)).not.toContain(attachmentSecret);
    expect(JSON.stringify(contextFailure)).not.toContain(contextSecret);
    expect(JSON.stringify(attachmentFailure)).not.toContain(attachmentSecret);
  });

  it("rejects extra internal fields and returns detached parsed values", () => {
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      membership_id: "membership_human",
    }).success).toBe(true);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      headers: { authorization: "Bearer secret" },
    }).success).toBe(false);
    expect(RealtimeSocketAttachmentSchema.safeParse({
      ...baseAttachment,
      content: "message body",
    }).success).toBe(false);

    const parsed = parseRealtimeAttachment(baseAttachment);
    expect(parsed).toEqual(baseAttachment);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(() => structuredClone(parsed)).not.toThrow();
  });
});

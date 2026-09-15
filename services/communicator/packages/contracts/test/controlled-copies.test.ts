import { describe, expect, it } from "vitest";
import {
  CONTROLLED_COPY_CLEANUP_MARGIN_MS,
  CONTROLLED_COPY_MAX_AGE_MS,
  ControlledCopyCompletionSchema,
  ControlledCopyOperationSchema,
} from "../src/controlled-copies";

describe("controlled-copy contracts", () => {
  it("keeps the cleanup margin inside the hard 30-day ceiling", () => {
    expect(CONTROLLED_COPY_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(CONTROLLED_COPY_CLEANUP_MARGIN_MS).toBeLessThan(
      CONTROLLED_COPY_MAX_AGE_MS,
    );
  });

  it("models a credential copy as auxiliary evidence without making it required", () => {
    const parsed = ControlledCopyOperationSchema.parse({
      id: "controlled_copy_session",
      tenant_id: "tenant_pilot",
      removal_id: "removal_message",
      resource_type: "message",
      resource_id: "message_one",
      content_generation: "message_one",
      deletion_epoch: 1,
      store: "session_credentials",
      owner: "session-credentials",
      content_class: "session_credential",
      reference: "session_ref",
      deletion_method: "preserve",
      required: false,
      copy_created_at: "2026-09-01T00:00:00.000Z",
      cleanup_margin_ms: CONTROLLED_COPY_CLEANUP_MARGIN_MS,
      cleanup_deadline: "2026-09-30T00:00:00.000Z",
      retention_deadline: "2026-10-01T00:00:00.000Z",
      status: "preserved",
      lease_token: null,
      lease_expires_at: null,
      last_error: null,
      completed_at: "2026-09-02T00:00:00.000Z",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    });
    expect(parsed.required).toBe(false);
    expect(parsed.deletion_method).toBe("preserve");
  });

  it("requires canonical archive evidence for global completion", () => {
    const result = ControlledCopyCompletionSchema.parse({
      tenant_id: "tenant_pilot",
      removal_id: "removal_message",
      resource_id: "message_one",
      content_generation: "message_one",
      deletion_epoch: 1,
      status: "incomplete",
      canonical_archive: "missing",
      required_stores: [
        "projection_backup",
        "synapse",
        "bridge_database",
        "media_store",
        "queue",
        "restic_snapshot",
      ],
      completed_stores: ["queue"],
      incomplete_stores: [],
      missing_stores: [],
      auxiliary_operations: [],
      alerts: ["canonical_archive_evidence_missing"],
      checked_at: "2026-09-02T00:00:00.000Z",
    });
    expect(result.status).toBe("incomplete");
  });
});

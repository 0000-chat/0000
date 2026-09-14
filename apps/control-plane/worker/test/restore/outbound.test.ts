import { describe, expect, it } from "vitest";
import { RemovalAuthoritySchema } from "@communicator/contracts";
import { fenceRestoredOutboundWork } from "../../restore/outbound";

const authority = RemovalAuthoritySchema.parse({
  id: "removal_restore_outbound",
  tenant_id: "tenant_restore_outbound",
  resource_type: "message",
  resource_id: "message_restore_outbound",
  content_generation: "message_restore_outbound",
  account_id: "account_restore_outbound",
  conversation_id: "conversation_restore_outbound",
  source_event_id: null,
  source_object_key: null,
  reason: "requested",
  removed_at: "2026-09-14T00:00:00.000Z",
  deletion_epoch: 1,
  status: "active",
  purge_status: "not_started",
  failure_code: null,
  completed_at: null,
  created_at: "2026-09-14T00:00:00.000Z",
  updated_at: "2026-09-14T00:00:00.000Z",
});

describe("restored outbound fence", () => {
  it("cancels pending work and preserves in-flight uncertainty", () => {
    const updates: Array<{ query: string; args: unknown[] }> = [];
    const sql = {
      exec: <T>(query: string, ...args: unknown[]) => {
        updates.push({ query, args });
        const rows = query.startsWith("SELECT status FROM outbound_dispatches")
          ? [
              { status: "pending" },
              { status: "dispatching" },
              { status: "dispatched" },
            ]
          : query.startsWith("SELECT status FROM commands")
            ? [{ status: "accepted" }, { status: "delivery_uncertain" }]
            : [];
        return { toArray: () => rows as T[] };
      },
    } as unknown as SqlStorage;

    const result = fenceRestoredOutboundWork(
      sql,
      [authority, authority],
      "2026-09-14T00:01:00.000Z",
    );

    expect(result).toEqual({
      cancelled_dispatches: 1,
      uncertain_dispatches: 1,
      cancelled_commands: 1,
      authority_ids: [authority.id],
    });
    expect(
      updates.filter(({ query }) =>
        query.startsWith("UPDATE outbound_dispatches"),
      ),
    ).toHaveLength(1);
    expect(
      updates.some(
        ({ query }) =>
          query.startsWith("UPDATE commands") &&
          query.includes("status IN ('accepted'"),
      ),
    ).toBe(true);
  });
});

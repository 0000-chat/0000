import type { RemovalAuthority } from "../../../../packages/contracts/src/removals";

/**
 * Fence outbound rows recreated from a restored projection ledger.  The
 * projection owns the SQLite transaction; this function deliberately accepts
 * its SqlStorage so the caller can invoke it after restoring outbound rows and
 * before publishing the projection as ready.
 *
 * A pending row is cancelled.  A row that was already between lease and
 * provider I/O becomes delivery_uncertain and keeps its uncertainty evidence;
 * clearing that distinction would allow a restore to resend a message whose
 * provider result is unknown.  Delivered rows retain their terminal evidence
 * and are redacted by the existing projection removal pass.
 */
export type RestoreOutboundFenceResult = {
  cancelled_dispatches: number;
  uncertain_dispatches: number;
  cancelled_commands: number;
  authority_ids: string[];
};

const messagePredicate = (authority: RemovalAuthority): string =>
  authority.resource_type === "conversation"
    ? "conversation_id = ?"
    : authority.resource_type === "message"
      ? "message_id = ?"
      : "1 = 0";

const dispatchCancellableStatuses = [
  "pending",
  "waiting_for_connection",
  "confirmation_required",
  "wakeup_failed",
] as const;

const commandStatuses = [
  "accepted",
  "waiting_for_connection",
  "confirmation_required",
  "scheduled",
  "reading",
  "typing",
  "submitted_to_matrix",
] as const;

/** Apply current removal authorities to rows restored into a projection DO. */
export const fenceRestoredOutboundWork = (
  sql: SqlStorage,
  authorities: readonly RemovalAuthority[],
  now: string,
): RestoreOutboundFenceResult => {
  const result: RestoreOutboundFenceResult = {
    cancelled_dispatches: 0,
    uncertain_dispatches: 0,
    cancelled_commands: 0,
    authority_ids: [],
  };
  const seen = new Set<string>();
  for (const authority of authorities) {
    if (seen.has(authority.id)) continue;
    seen.add(authority.id);
    if (
      authority.resource_type !== "message" &&
      authority.resource_type !== "conversation"
    ) {
      continue;
    }
    const predicate = messagePredicate(authority);
    const value = authority.resource_id;
    const dispatches = sql
      .exec<{ status: string }>(
        `SELECT status FROM outbound_dispatches WHERE ${predicate}`,
        value,
      )
      .toArray();
    if (dispatches.length === 0) continue;

    sql.exec(
      `UPDATE outbound_dispatches
       SET status = CASE
         WHEN status IN ('pending','waiting_for_connection','confirmation_required','wakeup_failed') THEN 'cancelled'
         WHEN status = 'dispatching' THEN 'delivery_uncertain'
         ELSE status
       END,
       chat_paused = CASE WHEN status = 'dispatching' OR status = 'delivery_uncertain' THEN 1 ELSE chat_paused END,
       uncertainty_reason = CASE WHEN status = 'dispatching' THEN COALESCE(uncertainty_reason, ?) ELSE uncertainty_reason END,
       uncertain_at = CASE WHEN status = 'dispatching' THEN COALESCE(uncertain_at, ?) ELSE uncertain_at END,
       dispatch_lease_id = CASE WHEN status IN ('pending','waiting_for_connection','confirmation_required','wakeup_failed','dispatching','delivery_uncertain') THEN NULL ELSE dispatch_lease_id END,
       dispatch_lease_expires_at = CASE WHEN status IN ('pending','waiting_for_connection','confirmation_required','wakeup_failed','dispatching','delivery_uncertain') THEN NULL ELSE dispatch_lease_expires_at END,
       updated_at = ?
       WHERE ${predicate}`,
      `removal_authority:${authority.id}`,
      now,
      now,
      value,
    );
    const cancelled = dispatches.filter((row) =>
      (dispatchCancellableStatuses as readonly string[]).includes(row.status),
    ).length;
    const uncertain = dispatches.filter(
      (row) => row.status === "dispatching",
    ).length;
    result.cancelled_dispatches += cancelled;
    result.uncertain_dispatches += uncertain;

    const commandRows = sql
      .exec<{ status: string }>(
        `SELECT status FROM commands WHERE id IN (SELECT command_id FROM outbound_dispatches WHERE ${predicate})`,
        value,
      )
      .toArray();
    sql.exec(
      `UPDATE commands
       SET status = CASE
         WHEN status IN ('accepted','waiting_for_connection','confirmation_required','scheduled','reading','typing','submitted_to_matrix') THEN 'cancelled'
         ELSE status
       END,
       failure_code = CASE
         WHEN status IN ('accepted','waiting_for_connection','confirmation_required','scheduled','reading','typing','submitted_to_matrix') THEN COALESCE(failure_code, ?)
         ELSE failure_code
       END,
       updated_at = ?
       WHERE id IN (SELECT command_id FROM outbound_dispatches WHERE ${predicate})`,
      `removal_authority:${authority.id}`,
      now,
      value,
    );
    result.cancelled_commands += commandRows.filter((row) =>
      (commandStatuses as readonly string[]).includes(row.status),
    ).length;
    result.authority_ids.push(authority.id);
  }
  return result;
};

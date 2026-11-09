import { z } from "zod";
import { getTenantProjection } from "./projection/routing";

const PAGE_SIZE = 32;
const TICK_LIMIT = 8;
const RPC_TIMEOUT_MS = 2_000;
const CLAIM_MS = 30_000;

/** Discovery and acknowledgements survive restarts; no outbound state lives here. */
export async function runDormantTenantBootstrapTick(
  env: Pick<Cloudflare.Env, "CONTROL_DB" | "TENANT_PROJECTION">,
): Promise<void> {
  const db = env.CONTROL_DB;
  // D1 batches are atomic. Overlapping ticks discover disjoint next pages;
  // neither can advance the cursor without first persisting those targets.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO tenant_wakeup_targets (tenant_id, source)
      SELECT id, 'directory' FROM tenants
      WHERE id > (SELECT directory_cursor FROM tenant_wakeup_bootstrap WHERE version = 1)
        AND (SELECT discovery_complete FROM tenant_wakeup_bootstrap WHERE version = 1) = 0
      ORDER BY id LIMIT ${PAGE_SIZE}`),
    db.prepare(`UPDATE tenant_wakeup_bootstrap SET directory_cursor = COALESCE(
      (SELECT MAX(id) FROM (SELECT id FROM tenants WHERE id > directory_cursor
        ORDER BY id LIMIT ${PAGE_SIZE})), directory_cursor)
      WHERE version = 1 AND discovery_complete = 0`),
    db.prepare(`UPDATE tenant_wakeup_bootstrap SET discovery_complete = 1
      WHERE version = 1 AND NOT EXISTS (SELECT 1 FROM tenants WHERE id > directory_cursor)`),
  ]);

  const now = Date.now();
  await db
    .prepare(`UPDATE tenant_wakeup_targets
    SET state = CASE WHEN attempts >= 3 THEN 'gap' ELSE 'retry' END,
      outcome = 'claim_expired', claim_token = NULL, lease_until_ms = NULL,
      due_at_ms = ?, checked_at_ms = ?
    WHERE tenant_id IN (SELECT tenant_id FROM tenant_wakeup_targets
      WHERE state = 'running' AND lease_until_ms <= ?
      ORDER BY lease_until_ms, tenant_id LIMIT ${TICK_LIMIT})`)
    .bind(now, now, now)
    .run();
  // Fresh targets precede retries, so a poison tenant cannot hold discovery up.
  // Old versions classified pristine storage as uninitialized. Consume that
  // legacy outcome once through the same bounded, token-fenced claim path.
  const targets = await db
    .prepare(`SELECT tenant_id FROM tenant_wakeup_targets
    WHERE due_at_ms <= ? AND ((state IN ('queued', 'retry') AND attempts < 3)
      OR (state = 'gap' AND outcome = 'uninitialized'))
    ORDER BY attempts, due_at_ms, tenant_id LIMIT ${TICK_LIMIT}`)
    .bind(now)
    .all<{ tenant_id: string }>();
  await Promise.all(
    targets.results.map(async ({ tenant_id }) => {
      const token = crypto.randomUUID();
      const claimed = await db
        .prepare(`UPDATE tenant_wakeup_targets
      SET state = 'running', attempts = MIN(attempts + 1, 3),
        outcome = CASE WHEN state = 'gap' THEN 'uninitialized_recheck' ELSE outcome END,
        claim_token = ?, lease_until_ms = ?
      WHERE tenant_id = ? AND due_at_ms <= ?
        AND ((state IN ('queued', 'retry') AND attempts < 3)
          OR (state = 'gap' AND outcome = 'uninitialized'))
      RETURNING attempts`)
        .bind(token, now + CLAIM_MS, tenant_id, now)
        .first<{ attempts: number }>();
      if (claimed === null) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          getTenantProjection(env, tenant_id).repairOutboundWakeup({
            schema_version: 1,
            tenant_id,
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("repair_timeout")),
              RPC_TIMEOUT_MS,
            );
          }),
        ]);
        await db
          .prepare(`UPDATE tenant_wakeup_targets
        SET state = ?, outcome = ?, alarm_at_ms = ?, checked_at_ms = ?,
          claim_token = NULL, lease_until_ms = NULL
        WHERE tenant_id = ? AND claim_token = ? AND lease_until_ms > ?`)
          .bind(
            result.kind,
            result.kind === "gap"
              ? result.reason === "uninitialized"
                ? "uninitialized_retained_state"
                : result.reason
              : result.kind,
            result.kind === "scheduled" ? result.alarm_at_ms : null,
            Date.now(),
            tenant_id,
            token,
            Date.now(),
          )
          .run();
      } catch {
        await db
          .prepare(`UPDATE tenant_wakeup_targets
        SET state = ?, outcome = 'repair_unavailable', due_at_ms = ?, checked_at_ms = ?,
          claim_token = NULL, lease_until_ms = NULL
        WHERE tenant_id = ? AND claim_token = ? AND lease_until_ms > ?`)
          .bind(
            claimed.attempts >= 3 ? "gap" : "retry",
            Date.now() + 1_000 * 2 ** claimed.attempts,
            Date.now(),
            tenant_id,
            token,
            Date.now(),
          )
          .run();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/** Internal operator evidence only: IDs/codes/deadlines, never message content. */
export async function readDormantTenantBootstrapReport(
  db: D1Database,
  page: { after: string; limit: number },
) {
  const parsed = z
    .strictObject({
      after: z.string(),
      limit: z.number().int().min(1).max(100),
    })
    .parse(page);
  const [state, counts, missing, targets] = await db.batch([
    db.prepare(
      "SELECT directory_cursor, discovery_complete FROM tenant_wakeup_bootstrap WHERE version = 1",
    ),
    db.prepare(
      "SELECT state, COUNT(*) AS count FROM tenant_wakeup_targets GROUP BY state",
    ),
    db.prepare(`SELECT COUNT(*) AS count FROM tenants t WHERE NOT EXISTS
      (SELECT 1 FROM tenant_wakeup_targets b WHERE b.tenant_id = t.id)`),
    db
      .prepare(`SELECT tenant_id, source, state, attempts, outcome, alarm_at_ms, checked_at_ms
      FROM tenant_wakeup_targets WHERE tenant_id > ? ORDER BY tenant_id LIMIT ?`)
      .bind(parsed.after, parsed.limit),
  ]);
  const discovery = z
    .tuple([z.object({ discovery_complete: z.literal(0).or(z.literal(1)) })])
    .parse(state?.results);
  const targetCounts = z
    .array(
      z.object({
        state: z.enum([
          "queued",
          "running",
          "retry",
          "scheduled",
          "idle",
          "gap",
        ]),
        count: z.number().int().nonnegative(),
      }),
    )
    .parse(counts?.results);
  const undiscovered = z
    .tuple([z.object({ count: z.number().int().nonnegative() })])
    .parse(missing?.results);
  // Supported production paths retain every tenant in D1 and route by its raw
  // canonical ID. This gate measures that population, not a live namespace
  // inventory. Out-of-band directory replacement needs operator reconciliation.
  const blockingReason =
    discovery[0].discovery_complete !== 1
      ? "directory_scan_incomplete"
      : undiscovered[0].count !== 0
        ? "directory_targets_missing"
        : targetCounts.some(({ state, count }) => state === "gap" && count > 0)
          ? "target_gaps"
          : targetCounts.some(
                ({ state, count }) =>
                  state !== "idle" && state !== "scheduled" && count > 0,
              )
            ? "targets_pending"
            : null;
  const readiness:
    | { gate: "ready"; blocking_reason: null }
    | { gate: "blocked"; blocking_reason: NonNullable<typeof blockingReason> } =
    blockingReason === null
      ? { gate: "ready", blocking_reason: null }
      : { gate: "blocked", blocking_reason: blockingReason };
  return {
    ...readiness,
    discovery: state?.results,
    counts: counts?.results,
    undiscovered_directory: missing?.results,
    targets: targets?.results,
  };
}

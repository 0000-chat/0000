import {
  claimNextHistoryRangeWork,
  getRange,
  scheduleHistoryRangeWork,
} from "./repository";
import { historyProviderFromEnv, type HistoryImportProvider } from "./provider";
import {
  createHistoryService,
  type HistoryServiceEnvironment,
} from "./service";

const DEFAULT_MAX_PAGES_PER_TICK = 10;
const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const UNEXPECTED_RETRY_DELAY_MS = 60_000;

export type HistoryImportRunnerDependencies = {
  createProvider?: (env: Cloudflare.Env) => HistoryImportProvider;
  now?: () => Date;
  applyEvents?: Parameters<typeof createHistoryService>[0]["applyEvents"];
  maxPagesPerTick?: number;
  leaseDurationMs?: number;
};

export type HistoryImportTickResult = {
  claimed: number;
  advanced: number;
};

const timestamp = (clock: () => Date): string => {
  const value = clock().toISOString();
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("invalid history clock");
  return value;
};

const boundedPageCount = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_MAX_PAGES_PER_TICK;
  if (!Number.isSafeInteger(value) || value < 1)
    return DEFAULT_MAX_PAGES_PER_TICK;
  return Math.min(value, 100);
};

const boundedLeaseDuration = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_LEASE_DURATION_MS;
  if (!Number.isSafeInteger(value) || value < 1)
    return DEFAULT_LEASE_DURATION_MS;
  return Math.min(value, 30 * 60_000);
};

/**
 * Run a bounded page batch. A lease is persisted before the provider call;
 * expiry makes a crashed invocation recoverable on the next cron tick.
 */
export async function runHistoryImportTick(
  env: Cloudflare.Env,
  dependencies: HistoryImportRunnerDependencies = {},
): Promise<HistoryImportTickResult> {
  const clock = dependencies.now ?? (() => new Date());
  const maxPages = boundedPageCount(dependencies.maxPagesPerTick);
  const leaseDurationMs = boundedLeaseDuration(dependencies.leaseDurationMs);
  const service = createHistoryService({
    provider: (dependencies.createProvider ?? historyProviderFromEnv)(env),
    now: clock,
    ...(dependencies.applyEvents === undefined
      ? {}
      : { applyEvents: dependencies.applyEvents }),
  });
  let claimedCount = 0;
  let advancedCount = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const now = timestamp(clock);
    const leaseToken = crypto.randomUUID();
    const leaseUntil = new Date(
      Date.parse(now) + leaseDurationMs,
    ).toISOString();
    const claim = await claimNextHistoryRangeWork(env.CONTROL_DB, {
      lease_token: leaseToken,
      lease_until: leaseUntil,
      now,
    });
    if (claim === null) break;
    claimedCount += 1;
    try {
      await service.advance({
        env: env as HistoryServiceEnvironment,
        tenantId: claim.tenant_id,
        importId: claim.import_id,
        accountId: claim.account_id,
        identityId: claim.identity_id,
        rangeId: claim.range_id,
        leaseToken,
        leaseUntil,
      });
      advancedCount += 1;
    } catch (error) {
      // The service handles provider/application failures itself. This path is
      // for an unexpected storage/runtime exception before it can reconcile;
      // release the lease with a durable wake and keep the next page bounded.
      try {
        const range = await getRange(
          env.CONTROL_DB,
          claim.import_id,
          claim.range_id,
        );
        await scheduleHistoryRangeWork(env.CONTROL_DB, {
          tenant_id: claim.tenant_id,
          import_id: claim.import_id,
          range_id: claim.range_id,
          account_id: claim.account_id,
          source_cursor: range.source_cursor,
          next_attempt_at: new Date(
            Date.parse(now) + UNEXPECTED_RETRY_DELAY_MS,
          ).toISOString(),
          updated_at: timestamp(clock),
          lease_token: leaseToken,
        });
      } catch {
        // Leave the lease fenced until expiry if storage itself is unavailable.
      }
      console.error({
        event: "history_import_tick_error",
        import_id: claim.import_id,
        range_id: claim.range_id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return { claimed: claimedCount, advanced: advancedCount };
}

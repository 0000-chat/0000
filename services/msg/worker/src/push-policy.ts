export const PUSH_INITIAL_DELAY_MS = 250;
export const PUSH_RETRY_INITIAL_DELAY_MS = 30 * 1_000;
export const PUSH_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;
export const PUSH_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const PUSH_DELIVERY_TIMEOUT_MS = 5_000;
export const PUSH_DELIVERY_LEASE_MS = PUSH_DELIVERY_TIMEOUT_MS + 5_000;

/** Capped exponential retry delay. The durable event deadline always wins. */
export function pushRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(Math.floor(attemptCount) - 1, 0), 10);
  return Math.min(PUSH_RETRY_INITIAL_DELAY_MS * 2 ** exponent, PUSH_RETRY_MAX_DELAY_MS);
}

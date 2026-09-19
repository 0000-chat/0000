export const WEBHOOK_INITIAL_DELAY_MS = 250;
export const WEBHOOK_RETRY_INITIAL_DELAY_MS = 30 * 1_000;
export const WEBHOOK_RETRY_MAX_DELAY_MS = 60 * 60 * 1_000;
export const WEBHOOK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const WEBHOOK_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const WEBHOOK_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Uses capped exponential backoff; the event deadline always wins over the next retry. */
export function webhookRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(Math.floor(attemptCount) - 1, 0), 10);
  return Math.min(WEBHOOK_RETRY_INITIAL_DELAY_MS * 2 ** exponent, WEBHOOK_RETRY_MAX_DELAY_MS);
}

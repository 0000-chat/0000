import {
  buildPlatformMiniflareRateLimits,
  buildPlatformTestRateLimitPolicy,
} from "../src/rate-limit-policy";

export const PLATFORM_TEST_MINIFLARE_RATE_LIMITS =
  buildPlatformMiniflareRateLimits(buildPlatformTestRateLimitPolicy());

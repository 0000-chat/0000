import { describe, expect, test } from "bun:test"

import { deriveConvexCloudUrl, getConvexUrl } from "./acp-bridge"

describe("bridge Convex URL resolution", () => {
  test("derives a Convex cloud URL from a Convex site URL", () => {
    expect(deriveConvexCloudUrl("https://example-123.convex.site")).toBe(
      "https://example-123.convex.cloud",
    )
  })

  test("prefers explicit flag and environment values", () => {
    const config = {
      appUrl: "https://0000.chat",
      bridgeApiUrl: "https://example-123.convex.site",
    }

    expect(getConvexUrl({ "convex-url": "https://flag.convex.cloud" }, config, {})).toBe(
      "https://flag.convex.cloud",
    )
    expect(
      getConvexUrl({}, config, { ZERO_CHAT_BRIDGE_CONVEX_URL: "https://env.convex.cloud" }),
    ).toBe("https://env.convex.cloud")
  })

  test("falls back to the paired bridge API URL before app URL derivation", () => {
    expect(
      getConvexUrl(
        {},
        {
          appUrl: "https://0000.chat",
          bridgeApiUrl: "https://uncommon-starfish-672.convex.site",
        },
        {},
      ),
    ).toBe("https://uncommon-starfish-672.convex.cloud")
  })
})


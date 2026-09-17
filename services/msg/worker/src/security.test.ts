import { expect, test } from "bun:test";

import { applySecurityHeaders } from "./security";

test("sets private relay security headers without third-party sources", () => {
  const headers = applySecurityHeaders(new Headers());

  expect(headers.get("cache-control")).toBe("private, no-store, no-transform");
  expect(headers.get("referrer-policy")).toBe("no-referrer");
  expect(headers.get("x-robots-tag")).toBe("noindex");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("x-frame-options")).toBe("DENY");
  expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(headers.get("permissions-policy")).toContain("camera=()");
  expect(headers.get("content-security-policy")).toBe(
    "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  );
});

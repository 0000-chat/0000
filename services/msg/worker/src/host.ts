export const DEFAULT_CANONICAL_ORIGIN = "https://0000.chat";
export const DEFAULT_LEGACY_ORIGIN = "https://msg.0000.chat";

/** Return an origin suitable for URL generation, preserving an explicit local HTTP origin. */
export function normalizeOrigin(value: string | undefined, fallback: string): string {
  try {
    const parsed = new URL(value ?? fallback);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return parsed.origin;
  } catch {
    return fallback;
  }
}

/**
 * Redirect only browser navigations from the retired host. API GETs carry an
 * explicit non-HTML representation and stay on the old origin so existing
 * clients can keep their host-scoped cookies and follow-up requests.
 */
export function redirectLegacyBrowserRequest(
  request: Request,
  canonicalOrigin: string,
  legacyOrigin = DEFAULT_LEGACY_ORIGIN,
): Response | undefined {
  if ((request.method !== "GET" && request.method !== "HEAD") || !isBrowserNavigation(request)) return undefined;
  const requestUrl = new URL(request.url);
  const canonical = normalizeOrigin(canonicalOrigin, requestUrl.origin);
  const legacy = normalizeOrigin(legacyOrigin, DEFAULT_LEGACY_ORIGIN);
  if (canonical === legacy || requestUrl.origin !== legacy) return undefined;

  const target = new URL(canonical);
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  return new Response(null, {
    status: 301,
    headers: {
      "cache-control": "no-store",
      location: target.toString(),
    },
  });
}

function isBrowserNavigation(request: Request): boolean {
  const accept = request.headers.get("accept");
  return accept === null || /(?:^|[,\s])text\/html(?:[,;\s]|$)/iu.test(accept);
}

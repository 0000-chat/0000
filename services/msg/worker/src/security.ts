const CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'";

export function applySecurityHeaders(headers: Headers, styleNonce?: string): Headers {
  const nonceSource = styleNonce && /^[A-Za-z0-9+/]{32}$/.test(styleNonce) ? ` 'nonce-${styleNonce}'` : "";
  headers.set("cache-control", "private, no-store, no-transform");
  headers.set("content-security-policy", nonceSource
    ? CONTENT_SECURITY_POLICY.replace("style-src 'self'", `style-src 'self'${nonceSource}`)
    : CONTENT_SECURITY_POLICY);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex");
  return headers;
}

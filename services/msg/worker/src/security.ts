const CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'";
const MANAGEMENT_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("form-action 'none'", "form-action 'self'");

export function applySecurityHeaders(headers: Headers, options: { readonly allowSameOriginForms?: boolean; readonly styleNonce?: string } | string = {}): Headers {
  const styleNonce = typeof options === "string" ? options : options.styleNonce;
  const allowSameOriginForms = typeof options === "string" ? false : options.allowSameOriginForms;
  const nonceSource = styleNonce && /^[A-Za-z0-9+/]{32}$/.test(styleNonce) ? ` 'nonce-${styleNonce}'` : "";
  headers.set("cache-control", "private, no-store, no-transform");
  const policy = allowSameOriginForms ? MANAGEMENT_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY;
  headers.set("content-security-policy", nonceSource ? policy.replace("style-src 'self'", `style-src 'self'${nonceSource}`) : policy);
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex");
  return headers;
}

import platform from "../../../platform/src/worker.ts";
import { provisionTrustedOAuthClient } from "../../../platform/src/oauth-installation.ts";
import { hashOpaque } from "../../../platform/src/platform-state.ts";

/*
 * Local proof only: the GitHub identity is synthetic; all session, organization,
 * selection, consent, installation and access-token issuance is real Platform.
 * The runner must supply nonempty synthetic GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET
 * bindings and intercept outbound fetches (no external network required):
 * github.com/login/oauth/access_token -> 200 JSON
 *   {access_token:"integrated-provider-token",token_type:"bearer",scope:"read:user user:email"}
 * api.github.com/user -> 200 JSON
 *   {id:817141,login:"integrated-human",name:"Integrated Human",avatar_url:null}
 * api.github.com/user/emails -> 200 JSON
 *   [{email:"integrated-human@example.test",primary:true,verified:true}]
 * Reject every other outbound request. The provider authorize URL is inspected,
 * not fetched; the callback below simulates the controlled provider redirect.
 * No browser UI or live GitHub authentication is claimed. Generated cookies,
 * OAuth codes, PKCE material and credentials stay in memory; never log them.
 */
export async function provisionHuman(env, context, service) {
  const base = new URL(env.PLATFORM_BASE_URL).origin;
  const cookies = new Map();
  const requireValue = (condition) => {
    if (!condition) throw new Error("Human OAuth fixture assertion failed");
  };
  requireValue(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

  async function request(path, expected, init = {}) {
    const url = new URL(path, base);
    requireValue(url.origin === base);
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set("cookie", [...cookies.values()].join("; "));
    const response = await platform.fetch(
      new Request(url, { ...init, headers, redirect: "manual" }),
      env,
      context,
    );
    if (response.status !== expected) {
      throw new Error(`Human OAuth fixture HTTP status ${response.status}`);
    }
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair);
    }
    return response;
  }
  const jsonPost = (body) => ({
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const formPost = (body) => ({
    method: "POST",
    headers: {
      origin: base,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  const location = (response) => {
    const value = response.headers.get("location");
    requireValue(typeof value === "string" && value.length > 0);
    const url = new URL(value, base);
    requireValue(url.origin === base);
    return url;
  };

  const start = await request(
    "/api/auth/sign-in/social",
    200,
    jsonPost({
      provider: "github",
      callbackURL: `${base}/account`,
    }),
  );
  const startBody = await start.json();
  requireValue(typeof startBody.url === "string");
  const providerUrl = new URL(startBody.url);
  const state = providerUrl.searchParams.get("state");
  requireValue(providerUrl.origin === "https://github.com" && state);
  const signedIn = await request(
    `/api/auth/callback/github?${new URLSearchParams({ code: "fixture-provider-code", state })}`,
    302,
  );
  requireValue(location(signedIn).pathname === "/account");
  const session = await (await request("/api/auth/get-session", 200)).json();
  requireValue(
    typeof session.user?.id === "string" &&
      typeof session.session?.id === "string",
  );
  const userId = session.user.id;
  const organization = await (await request("/api/me", 200)).json();
  requireValue(
    organization.userId === userId &&
      typeof organization.organizationId === "string" &&
      typeof organization.membershipId === "string",
  );
  const { organizationId, membershipId } = organization;

  // This deployment-trusted client registration is the only fixture authority
  // write. No session, flow, installation or credential rows are inserted here.
  const redirectUri = "https://communicator.integrated.test/oauth/callback";
  const client = await provisionTrustedOAuthClient(
    env.IDENTITY_DB,
    env.BETTER_AUTH_SECRET,
    {
      serviceId: service.serviceId,
      redirectUri,
      capabilities: service.allowedCapabilities,
      authMethod: "client_secret_post",
      purpose: "first_party_browser",
    },
  );
  requireValue(typeof client.clientSecret === "string");
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...challengeBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const oauthState = crypto.randomUUID();
  const query = new URLSearchParams({
    client_id: client.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: service.allowedCapabilities.join(" "),
    resource: service.audience,
    state: oauthState,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorize = await request(`/api/auth/oauth2/authorize?${query}`, 302);
  const selection = location(authorize);
  requireValue(selection.pathname === "/oauth2/selection");
  await request(selection, 200);
  const flow = await env.IDENTITY_DB.prepare(
    `SELECT id FROM platform_oauth_flow
     WHERE user_id = ? AND session_id = ? AND state = ? AND purpose = 'first_party_browser'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(userId, session.session.id, oauthState)
    .first();
  requireValue(flow?.id);
  const selected = await request(
    "/oauth2/selection",
    303,
    formPost({ flowId: flow.id, organizationId }),
  );
  const continued = await request(location(selected), 302);
  const consentLocation = location(continued);
  const consent = await request(
    "/api/auth/oauth2/consent",
    200,
    jsonPost({
      accept: true,
      oauth_query: consentLocation.search.slice(1),
    }),
  );
  const consentBody = await consent.json();
  const callbackValue = consentBody.redirect_uri ?? consentBody.url;
  requireValue(typeof callbackValue === "string");
  const callback = new URL(callbackValue);
  requireValue(
    `${callback.origin}${callback.pathname}` === redirectUri &&
      callback.searchParams.get("state") === oauthState,
  );
  const code = callback.searchParams.get("code");
  requireValue(code && !callback.searchParams.has("error"));
  const token = await (
    await request(
      "/api/auth/oauth2/token",
      200,
      formPost({
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
        resource: service.audience,
      }),
    )
  ).json();
  requireValue(
    typeof token.access_token === "string" &&
      token.access_token.length > 0 &&
      token.refresh_token === undefined,
  );

  // Read-only evidence binds the returned token to the actual activated flow,
  // live login session and human membership, rather than inventing lineage.
  const lineage = await env.IDENTITY_DB.prepare(
    `SELECT c.id AS credential_id, c.kind, c.subject_id, c.membership_id, c.grant_id,
            i.purpose, i.user_id, i.organization_id, f.session_id
     FROM platform_credential c
     JOIN platform_oauth_installation i ON i.id = c.oauth_installation_id
     JOIN platform_oauth_flow f ON f.installation_id = i.id
     JOIN session s ON s.id = f.session_id
     JOIN member m ON m.id = c.membership_id AND m.userId = i.user_id
     WHERE c.credential_hash = ? AND c.oauth_origin = 'better-auth'
       AND c.revoked_at IS NULL AND i.active = 1 AND i.client_id = ?
       AND f.id = ? AND f.status = 'activated' AND m.organizationId = i.organization_id`,
  )
    .bind(await hashOpaque(token.access_token), client.clientId, flow.id)
    .first();
  requireValue(
    lineage?.kind === "human" &&
      lineage.purpose === "first_party_browser" &&
      lineage.user_id === userId &&
      lineage.subject_id === userId &&
      lineage.organization_id === organizationId &&
      lineage.membership_id === membershipId &&
      lineage.session_id === session.session.id &&
      lineage.grant_id === null,
  );
  return {
    credential: token.access_token,
    credentialId: lineage.credential_id,
    userId,
    organizationId,
    membershipId,
    platformMembershipId: membershipId,
  };
}

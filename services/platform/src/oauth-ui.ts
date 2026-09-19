import { escapeHtml, htmlResponse } from "./account-ui";
import {
  parseOAuthQuery,
  type OAuthClientRecord,
  type OAuthFlow,
} from "./oauth-installation";

export interface OAuthOrganizationChoice {
  organizationId: string;
  organizationName: string;
  role: string;
  suspendedAt: number | null;
}

export function oauthSelectionPage(
  flow: OAuthFlow,
  client: OAuthClientRecord,
  organizations: OAuthOrganizationChoice[],
): Response {
  const options = organizations
    .filter((organization) => organization.suspendedAt === null)
    .map(
      (organization) =>
        `<option value="${escapeHtml(organization.organizationId)}">${escapeHtml(organization.organizationName)} · ${escapeHtml(organization.role)}</option>`,
    )
    .join("");
  const capabilities = (
    parseOAuthQuery(flow.oauth_query)?.scopes ?? client.capabilities
  )
    .map((capability) => `<li>${escapeHtml(capability)}</li>`)
    .join("");
  return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Choose access · 0000 Platform</title><link rel="stylesheet" href="/account.css"></head>
<body><main class="shell"><header class="brand"><p class="eyebrow">0000 Platform</p>
<h1>Choose access</h1><p class="lede">Select the organization that ${escapeHtml(client.clientId)} may access through ${escapeHtml(client.serviceId)}.</p></header>
<section class="card"><p class="field-label">Requested capabilities</p><ul>${capabilities}</ul>
<form method="post" action="/oauth2/selection"><input type="hidden" name="flowId" value="${escapeHtml(flow.id)}">
<label for="oauth-organization">Organization</label><select id="oauth-organization" name="organizationId" required>${options}</select>
<button class="primary-button" type="submit">Continue to consent</button></form>
<p class="hint">Your choice applies only to this authorization request.</p></section></main></body></html>`);
}

export function oauthConsentPage(
  query: string,
  client: OAuthClientRecord,
  flow: OAuthFlow | null,
): Response {
  const capabilities = (parseOAuthQuery(query)?.scopes ?? client.capabilities)
    .map((capability) => `<li>${escapeHtml(capability)}</li>`)
    .join("");
  const flowId = flow?.id ?? "";
  return htmlResponse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve access · 0000 Platform</title><link rel="stylesheet" href="/account.css"></head>
<body><main class="shell"><header class="brand"><p class="eyebrow">0000 Platform</p>
<h1>Approve access</h1><p class="lede">${escapeHtml(client.clientId)} is requesting access to ${escapeHtml(client.serviceId)}.</p></header>
<section class="card"><p class="field-label">Capabilities</p><ul>${capabilities}</ul>
<form method="post" action="/api/auth/oauth2/consent"><input type="hidden" name="accept" value="true">
<input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
<input type="hidden" name="flow_id" value="${escapeHtml(flowId)}">
<button class="primary-button" type="submit">Approve access</button></form>
<form method="post" action="/api/auth/oauth2/consent"><input type="hidden" name="accept" value="false">
<input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
<button class="quiet-button" type="submit">Deny</button></form>
<p class="hint">The grant is tied to this organization, membership and registered client.</p></section></main></body></html>`);
}

export function oauthErrorPage(message: string, status = 400): Response {
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OAuth request unavailable</title><link rel="stylesheet" href="/account.css"></head><body><main class="shell"><section class="card"><h1>OAuth request unavailable</h1><p class="notice">${escapeHtml(message)}</p><p><a href="/account">Return to Platform</a></p></section></main></body></html>`,
    status,
  );
}

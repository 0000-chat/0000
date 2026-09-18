import type { OrganizationRole } from "./organization-state";

export interface AccountProvider {
  id: string;
  providerId: string;
}

export interface AccountOrganization {
  id: string;
  name: string;
  role: OrganizationRole;
  suspended: boolean;
}

export interface AccountMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  disabled: boolean;
}

export interface AccountInvitation {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: OrganizationRole;
  expiresAt: number;
  suspended: boolean;
}

export interface OrganizationDetails {
  id: string;
  name: string;
  role: OrganizationRole;
  suspended: boolean;
  viewerUserId: string;
  members: AccountMember[];
  invitations: AccountInvitation[];
}

export interface AccountView {
  name: string;
  email: string;
  image: string | null;
  providers: AccountProvider[];
  defaultOrganization: {
    name: string | null;
    role: string | null;
    suspended: boolean;
  };
  organizations: AccountOrganization[];
  selectedOrganizationId: string | null;
  selectedOrganization: OrganizationDetails | null;
  invitations: AccountInvitation[];
  isOperator: boolean;
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.href.length > 2048
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function document(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 0000 Platform</title>
  <link rel="stylesheet" href="/account.css">
  <script src="/account.js" defer></script>
</head>
<body>
  <main class="shell">${body}</main>
</body>
</html>`;
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

export function loginPage(message = ""): Response {
  const error = message
    ? `<p class="notice" role="alert">${escapeHtml(message)}</p>`
    : "";
  return htmlResponse(
    document(
      "Sign in",
      `<header class="brand">
        <p class="eyebrow">0000</p>
        <h1>Sign in to Platform</h1>
        <p class="lede">Use a Google or GitHub account to manage your Platform identity.</p>
      </header>
      ${error}
      <div class="actions" aria-label="Sign-in providers">
        <button type="button" class="provider-button" data-auth-provider="google">Continue with Google</button>
        <button type="button" class="provider-button" data-auth-provider="github">Continue with GitHub</button>
      </div>
      <p id="page-status" class="status" role="status" aria-live="polite"></p>`,
    ),
  );
}

function providerLabel(providerId: string): string {
  return providerId === "google" ? "Google" : "GitHub";
}

function linkedProviderMarkup(provider: AccountProvider): string {
  const label = providerLabel(provider.providerId);
  return `<li class="provider-row">
    <span>${escapeHtml(label)} is linked</span>
    <button type="button" class="quiet-button" data-unlink-account="${escapeHtml(provider.id)}" data-provider-name="${escapeHtml(label)}">Unlink ${escapeHtml(label)}</button>
  </li>`;
}

function availableProviderMarkup(providerId: string): string {
  const label = providerLabel(providerId);
  return `<li class="provider-row">
    <span>${escapeHtml(label)} is not linked</span>
    <button type="button" class="quiet-button" data-link-provider="${escapeHtml(providerId)}">Link ${escapeHtml(label)}</button>
  </li>`;
}

export function organizationDetailsMarkup(
  organization: OrganizationDetails | null,
): string {
  if (!organization) {
    return `<p class="access access-missing">You have no current organization memberships. Use an invitation to join an organization, or create one below.</p>`;
  }

  const isManager =
    organization.role === "owner" || organization.role === "admin";
  const canManage = isManager && !organization.suspended;
  const nameForm = canManage
    ? `<form data-rename-organization>
        <input type="hidden" name="organizationId" value="${escapeHtml(organization.id)}">
        <label for="organization-name">Organization name</label>
        <input id="organization-name" name="name" type="text" value="${escapeHtml(organization.name)}" maxlength="100" required>
        <button type="submit" class="primary-button">Save organization name</button>
      </form>`
    : `<p class="organization-name">${escapeHtml(organization.name)}</p>`;
  const memberRoleChoices =
    organization.role === "owner"
      ? ["owner", "admin", "member"]
      : ["admin", "member"];
  const invitationRoleOptions =
    organization.role === "owner"
      ? `<option value="member" selected>Member</option><option value="admin">Admin</option><option value="owner">Owner</option>`
      : `<option value="member" selected>Member</option><option value="admin">Admin</option>`;
  const members = organization.members
    .map((member) => {
      const memberRoleOptions = memberRoleChoices
        .map(
          (role) =>
            `<option value="${role}"${role === member.role ? " selected" : ""}>${role[0]!.toUpperCase()}${role.slice(1)}</option>`,
        )
        .join("");
      const isSelf = member.userId === organization.viewerUserId;
      const canManageMember =
        canManage &&
        !isSelf &&
        (organization.role === "owner" || member.role !== "owner");
      const roleControl = canManageMember
        ? `<label class="visually-hidden" for="member-role-${escapeHtml(member.id)}">Role for ${escapeHtml(member.name)}</label>
           <select id="member-role-${escapeHtml(member.id)}" data-member-role="${escapeHtml(member.id)}">${memberRoleOptions}</select>
           <button type="button" class="quiet-button" data-update-member-role="${escapeHtml(member.id)}">Save role</button>`
        : "";
      const removeControl = canManageMember
        ? `<button type="button" class="quiet-button" data-remove-member="${escapeHtml(member.id)}">Remove</button>`
        : "";
      return `<li class="management-row">
        <div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.email)}</span><small>${escapeHtml(member.role)}${member.disabled ? " · disabled account" : ""}${isSelf ? " · you" : ""}</small></div>
        <div class="row-actions">${roleControl}${removeControl}</div>
      </li>`;
    })
    .join("");
  const invitations = organization.invitations
    .map((invitation) => {
      const canCancel =
        canManage &&
        (organization.role === "owner" || invitation.role !== "owner");
      const link = `/account?invitation=${encodeURIComponent(invitation.id)}`;
      return `<li class="management-row">
        <div><strong>${escapeHtml(invitation.email)}</strong><span>Invited as ${escapeHtml(invitation.role)} · expires ${escapeHtml(new Date(invitation.expiresAt).toLocaleString())}</span>
          <p class="invitation-link"><a href="${escapeHtml(link)}">Invitation link</a> <button type="button" class="quiet-button" data-copy-invitation="${escapeHtml(invitation.id)}">Copy link</button></p>
        </div>
        ${canCancel ? `<button type="button" class="quiet-button" data-cancel-invitation="${escapeHtml(invitation.id)}">Cancel invitation</button>` : ""}
      </li>`;
    })
    .join("");
  const invitationForm = canManage
    ? `<form data-create-invitation>
        <input type="hidden" name="organizationId" value="${escapeHtml(organization.id)}">
        <label for="invite-email">Invite by email</label>
        <input id="invite-email" name="email" type="email" maxlength="254" autocomplete="email" required>
        <label for="invite-role">Role</label>
        <select id="invite-role" name="role">${invitationRoleOptions}</select>
        <button type="submit" class="primary-button">Create invitation</button>
      </form>`
    : "";
  const suspensionNotice = organization.suspended
    ? `<p class="notice" role="status">This organization is suspended. An operator must restore it before tenant administration can continue.</p>`
    : "";
  const leaveControl = organization.suspended
    ? `<p class="hint">Membership changes are unavailable while this organization is suspended.</p>`
    : `<form data-leave-organization>
        <input type="hidden" name="organizationId" value="${escapeHtml(organization.id)}">
        <button type="submit" class="quiet-button">Leave organization</button>
      </form>`;

  return `<div class="organization-details" data-organization-id="${escapeHtml(organization.id)}">
    ${suspensionNotice}
    <p class="access ${organization.suspended ? "access-missing" : "access-current"}">Your current role is ${escapeHtml(organization.role)}.</p>
    ${nameForm}
    <h3>Members</h3>
    <ul class="management-list">${members}</ul>
    ${invitationForm}
    <h3>Pending invitations</h3>
    <ul class="management-list">${invitations || `<li class="muted">No pending invitations.</li>`}</ul>
    ${leaveControl}
    <p data-organization-status class="status" role="status" aria-live="polite"></p>
  </div>`;
}

export function accountPage(view: AccountView): Response {
  const image = safeAvatarUrl(view.image);
  const avatar = image
    ? `<img class="avatar" src="${escapeHtml(image)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="avatar avatar-empty" aria-hidden="true">${escapeHtml(view.name.slice(0, 1).toUpperCase() || "?")}</div>`;
  const providers = new Set(
    view.providers.map((provider) => provider.providerId),
  );
  const linked = view.providers
    .filter(
      (provider) =>
        provider.providerId === "google" || provider.providerId === "github",
    )
    .map(linkedProviderMarkup);
  const missing = (["google", "github"] as const)
    .filter((providerId) => !providers.has(providerId))
    .map(availableProviderMarkup);
  const defaultMembership = view.defaultOrganization.suspended
    ? `<p class="access access-missing">This organization is suspended and access is unavailable.</p>`
    : view.defaultOrganization.role
      ? `<p class="access access-current">Current access: ${escapeHtml(view.defaultOrganization.role)} membership is active.</p>`
      : `<p class="access access-missing">You no longer have access to the default organization. Ask an owner to invite you again.</p>`;
  const defaultOrganization = view.defaultOrganization.name
    ? `<p class="organization-name">${escapeHtml(view.defaultOrganization.name)}</p>${defaultMembership}`
    : `<p class="access access-missing">The default organization is unavailable.</p>`;
  const organizationOptions = view.organizations
    .map(
      (organization) =>
        `<option value="${escapeHtml(organization.id)}"${organization.id === view.selectedOrganizationId ? " selected" : ""}>${escapeHtml(organization.name)} · ${escapeHtml(organization.role)}${organization.suspended ? " · suspended" : ""}</option>`,
    )
    .join("");
  const pendingInvitations = view.invitations
    .map(
      (invitation) =>
        `<li class="management-row">
          <div><strong>${escapeHtml(invitation.organizationName)}</strong><span>${escapeHtml(invitation.role)} invitation for ${escapeHtml(invitation.email)}</span></div>
          ${invitation.suspended ? `<span class="muted">Unavailable while suspended</span>` : `<button type="button" class="quiet-button" data-accept-invitation="${escapeHtml(invitation.id)}">Accept invitation</button>`}
        </li>`,
    )
    .join("");
  const operatorSection = view.isOperator
    ? `<section class="card" aria-labelledby="operator-heading">
        <h2 id="operator-heading">Platform operator</h2>
        <p class="hint">Restricted lifecycle controls for the configured operator account.</p>
        <div id="operator-panel" data-operator-panel>
          <p class="status">Loading operator controls…</p>
        </div>
        <p id="operator-status" class="status" role="status" aria-live="polite"></p>
      </section>`
    : "";

  return htmlResponse(
    document(
      "Your account",
      `<header class="account-header">
        <div>
          <p class="eyebrow">0000 Platform</p>
          <h1>Your account</h1>
        </div>
        ${avatar}
      </header>
      <section class="card" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <p class="read-only"><span class="field-label">Email</span><span>${escapeHtml(view.email)}</span></p>
        <form id="profile-form">
          <label for="display-name">Display name</label>
          <input id="display-name" name="name" type="text" value="${escapeHtml(view.name)}" maxlength="100" required autocomplete="name">
          <label for="avatar-url">Avatar image URL <span class="optional">optional</span></label>
          <input id="avatar-url" name="avatarUrl" type="url" value="${escapeHtml(image ?? "")}" maxlength="2048" inputmode="url" autocomplete="url" placeholder="https://example.com/avatar.png">
          <p class="hint">Avatar images must use HTTPS.</p>
          <button type="submit" class="primary-button">Save profile</button>
          <p id="profile-status" class="status" role="status" aria-live="polite"></p>
        </form>
      </section>
      <section class="card" aria-labelledby="organization-heading">
        <h2 id="organization-heading">Organizations</h2>
        <label for="organization-select">Choose an organization</label>
        <select id="organization-select"${view.organizations.length ? "" : " disabled"}>${organizationOptions}</select>
        <div id="organization-details">${organizationDetailsMarkup(view.selectedOrganization)}</div>
        <form id="create-organization-form">
          <label for="new-organization-name">Create an organization</label>
          <input id="new-organization-name" name="name" type="text" maxlength="100" required>
          <button type="submit" class="primary-button">Create organization</button>
        </form>
        <p id="organization-create-status" class="status" role="status" aria-live="polite"></p>
        <h3>Default organization receipt</h3>
        ${defaultOrganization}
      </section>
      <section class="card" aria-labelledby="invitations-heading">
        <h2 id="invitations-heading">Invitations for you</h2>
        <ul class="management-list">${pendingInvitations || `<li class="muted">No current invitations for your verified email.</li>`}</ul>
        <p id="invitation-status" class="status" role="status" aria-live="polite"></p>
      </section>
      <section class="card" aria-labelledby="providers-heading">
        <h2 id="providers-heading">Sign-in providers</h2>
        <ul class="provider-list">${[...linked, ...missing].join("")}</ul>
        <p id="provider-status" class="status" role="status" aria-live="polite"></p>
      </section>
      <footer class="account-footer">
        <button type="button" id="sign-out" class="quiet-button">Sign out</button>
        <a href="/login">Sign-in page</a>
      </footer>
      <p id="page-status" class="status" role="status" aria-live="polite"></p>
      ${operatorSection}`,
    ),
  );
}

export function assetResponse(
  body: string,
  contentType:
    | "application/javascript; charset=utf-8"
    | "text/css; charset=utf-8",
): Response {
  return new Response(body, {
    headers: {
      ...securityHeaders,
      "content-type": contentType,
    },
  });
}

export const accountCss = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #17233a;
  background: #f3f6fb;
  font-synthesis: none;
}

* { box-sizing: border-box; }

body { margin: 0; min-width: 320px; }

.shell { width: min(100% - 32px, 680px); margin: 48px auto; }
.brand { margin: 0 auto 28px; max-width: 520px; }
.eyebrow { margin: 0 0 8px; color: #52698d; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(2rem, 5vw, 2.7rem); line-height: 1.1; }
h2 { margin: 0 0 18px; font-size: 1.18rem; }
.lede { margin: 12px 0 0; color: #526078; line-height: 1.6; }
.card { margin-top: 18px; padding: 24px; border: 1px solid #dce4f0; border-radius: 18px; background: #fff; box-shadow: 0 14px 34px rgb(27 49 84 / 5%); }
.account-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.avatar { flex: 0 0 auto; width: 64px; height: 64px; border-radius: 50%; object-fit: cover; background: #e6edf8; }
.avatar-empty { display: grid; place-items: center; color: #315c9a; font-size: 1.5rem; font-weight: 700; }
.actions { display: grid; gap: 12px; max-width: 520px; }
button, input { font: inherit; }
button { min-height: 44px; cursor: pointer; }
button:disabled { cursor: wait; opacity: 0.65; }
.provider-button, .primary-button { width: 100%; border: 1px solid #2459a8; border-radius: 10px; background: #2459a8; color: #fff; font-weight: 700; }
.provider-button { background: #fff; color: #1c3f70; }
.primary-button { margin-top: 8px; }
label, .field-label { display: block; margin: 16px 0 7px; color: #465875; font-size: 0.9rem; font-weight: 700; }
input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid #c9d4e4; border-radius: 9px; color: #17233a; background: #fff; }
input:focus, button:focus-visible, a:focus-visible { outline: 3px solid #91b7f4; outline-offset: 2px; }
.read-only { margin: 0; color: #17233a; }
.read-only .field-label { margin-top: 0; }
.hint, .optional { color: #677895; font-size: 0.84rem; }
.hint { margin: 7px 0 8px; }
.organization-name { margin: 0; font-size: 1.03rem; font-weight: 700; }
.access { margin: 12px 0 0; line-height: 1.5; }
.access-current { color: #276246; }
.access-missing { color: #74521c; }
.provider-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.provider-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.quiet-button { min-height: 38px; padding: 6px 12px; border: 1px solid #c9d4e4; border-radius: 8px; background: #fff; color: #27476f; font-weight: 650; }
.account-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 22px; }
.account-footer a { color: #2459a8; }
.notice { max-width: 520px; margin: 0 0 18px; padding: 12px 14px; border: 1px solid #edce98; border-radius: 10px; background: #fff8e9; color: #634819; line-height: 1.5; }
.status { min-height: 1.2em; margin: 8px 0 0; color: #4d627e; line-height: 1.45; }
h3 { margin: 22px 0 12px; font-size: 1rem; }
.management-list { display: grid; gap: 12px; margin: 0 0 18px; padding: 0; list-style: none; }
.management-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e8edf5; }
.management-row > div:first-child { display: grid; gap: 3px; min-width: 0; }
.management-row span, .management-row small, .muted { color: #677895; font-size: 0.87rem; overflow-wrap: anywhere; }
.row-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.row-actions select { width: auto; min-height: 38px; }
.invitation-link { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 8px 0 0; }
.invitation-link a { color: #2459a8; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 520px) {
  .shell { margin: 24px auto; }
  .card { padding: 18px; }
  .provider-row, .management-row { align-items: flex-start; flex-direction: column; }
}`;

export const accountScript = `const providerHosts = {
  google: "https://accounts.google.com",
  github: "https://github.com",
};

function showMessage(target, message) {
  if (target) target.textContent = message;
}

async function responseData(response) {
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const safeMessage = typeof data.message === "string" ? data.message : "The request could not be completed.";
    throw new Error(safeMessage);
  }
  return data;
}

function accountCallback() {
  return new URL("/account", window.location.origin).href;
}

async function beginProvider(provider, linking) {
  const endpoint = linking ? "/api/auth/link-social" : "/api/auth/sign-in/social";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      callbackURL: accountCallback(),
      errorCallbackURL: new URL("/login", window.location.origin).href,
      disableRedirect: true,
    }),
  });
  const data = await responseData(response);
  if (typeof data.url !== "string") throw new Error("The provider did not return a sign-in URL.");
  const target = new URL(data.url);
  if (target.protocol !== "https:" || target.origin !== providerHosts[provider]) {
    throw new Error("The provider returned an unexpected sign-in URL.");
  }
  window.location.assign(target.href);
}

document.querySelectorAll("[data-auth-provider]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById("page-status");
    button.disabled = true;
    showMessage(status, "Connecting to your provider…");
    try {
      await beginProvider(button.dataset.authProvider, false);
    } catch (error) {
      button.disabled = false;
      showMessage(status, error instanceof Error ? error.message : "Sign-in failed.");
    }
  });
});

document.querySelectorAll("[data-link-provider]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById("provider-status");
    button.disabled = true;
    showMessage(status, "Confirming the second account…");
    try {
      await beginProvider(button.dataset.linkProvider, true);
    } catch (error) {
      button.disabled = false;
      showMessage(status, error instanceof Error ? error.message : "Account linking failed.");
    }
  });
});

document.querySelectorAll("[data-unlink-account]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById("provider-status");
    button.disabled = true;
    showMessage(status, "Removing the provider…");
    try {
      await responseData(await fetch("/api/auth/unlink-account", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: button.dataset.unlinkAccount }),
      }));
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      const fallback = "The last usable provider cannot be unlinked.";
      showMessage(status, error instanceof Error ? error.message : fallback);
    }
  });
});

function accountLocation(organizationId) {
  const target = new URL("/account", window.location.origin);
  if (typeof organizationId === "string" && organizationId) {
    target.searchParams.set("organizationId", organizationId);
  }
  return target.href;
}

async function postAccountJson(path, body) {
  return responseData(await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

let organizationDetailsGeneration = 0;

async function loadOrganizationDetails(organizationId) {
  const requestGeneration = ++organizationDetailsGeneration;
  const details = document.getElementById("organization-details");
  const isCurrentRequest = () =>
    requestGeneration === organizationDetailsGeneration &&
    organizationSelect?.value === organizationId;
  if (!details || !organizationId) return false;
  showMessage(details, "Loading organization…");
  try {
    const response = await fetch(
      "/api/account/organizations/detail?organizationId=" + encodeURIComponent(organizationId),
      { credentials: "same-origin" },
    );
    if (!isCurrentRequest()) return false;
    if (!response.ok) {
      const data = await responseData(response);
      throw new Error(data.message || "Organization access could not be loaded.");
    }
    const markup = await response.text();
    if (!isCurrentRequest()) return false;
    details.innerHTML = markup;
    return true;
  } catch (error) {
    if (isCurrentRequest()) {
      showMessage(details, error instanceof Error ? error.message : "Organization access could not be loaded.");
    }
    return false;
  }
}

const organizationSelect = document.getElementById("organization-select");
organizationSelect?.addEventListener("change", async () => {
  await loadOrganizationDetails(organizationSelect.value);
});

const organizationDetails = document.getElementById("organization-details");
organizationDetails?.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const formData = new FormData(form);
  const organizationId = String(formData.get("organizationId") || "");
  let path;
  let body;
  if (form.matches("[data-rename-organization]")) {
    path = "/api/account/organizations/update";
    body = { organizationId, name: formData.get("name") };
  } else if (form.matches("[data-create-invitation]")) {
    path = "/api/account/invitations/create";
    body = { organizationId, email: formData.get("email"), role: formData.get("role") };
  } else if (form.matches("[data-leave-organization]")) {
    path = "/api/account/members/leave";
    body = { organizationId };
  } else {
    return;
  }
  event.preventDefault();
  const status = form.parentElement?.querySelector("[data-organization-status]");
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  showMessage(status, "Saving…");
  try {
    const result = await postAccountJson(path, body);
    if (path === "/api/account/invitations/create") {
      window.location.assign(accountLocation(organizationId));
      return;
    }
    if (path === "/api/account/members/leave") {
      window.location.assign(accountLocation());
      return;
    }
    if (organizationSelect?.value === organizationId) {
      const loaded = await loadOrganizationDetails(organizationId);
      if (loaded) {
        const refreshedStatus = document.querySelector("[data-organization-status]");
        showMessage(refreshedStatus, result.message || "Changes saved.");
      }
    }
  } catch (error) {
    if (button) button.disabled = false;
    showMessage(status, error instanceof Error ? error.message : "Changes could not be saved.");
  }
});

organizationDetails?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest("button[data-update-member-role], button[data-remove-member], button[data-cancel-invitation], button[data-copy-invitation]")
    : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const organizationId = organizationDetails.querySelector("[data-organization-id]")?.dataset.organizationId || "";
  const status = organizationDetails.querySelector("[data-organization-status]");
  const memberId = button.dataset.updateMemberRole || button.dataset.removeMember;
  const invitationId = button.dataset.cancelInvitation;
  try {
    if (button.dataset.copyInvitation) {
      const link = new URL("/account", window.location.origin);
      link.searchParams.set("invitation", button.dataset.copyInvitation);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link.href);
      } else {
        const temporary = document.createElement("textarea");
        temporary.value = link.href;
        document.body.append(temporary);
        temporary.select();
        document.execCommand("copy");
        temporary.remove();
      }
      showMessage(status, "Invitation link copied.");
      return;
    }
    button.disabled = true;
    if (button.dataset.updateMemberRole && memberId) {
      const role = document.getElementById("member-role-" + memberId)?.value;
      await postAccountJson("/api/account/members/role", { organizationId, membershipId: memberId, role });
    } else if (button.dataset.removeMember && memberId) {
      await postAccountJson("/api/account/members/remove", { organizationId, membershipId: memberId });
    } else if (invitationId) {
      await postAccountJson("/api/account/invitations/cancel", { organizationId, invitationId });
    }
    window.location.assign(accountLocation(organizationId));
  } catch (error) {
    button.disabled = false;
    showMessage(status, error instanceof Error ? error.message : "The change could not be completed.");
  }
});

document.getElementById("create-organization-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("organization-create-status");
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showMessage(status, "Creating organization…");
  try {
    const result = await postAccountJson("/api/account/organizations/create", {
      name: new FormData(form).get("name"),
    });
    window.location.assign(accountLocation(result.organizationId));
  } catch (error) {
    button.disabled = false;
    showMessage(status, error instanceof Error ? error.message : "Organization could not be created.");
  }
});

document.querySelectorAll("[data-accept-invitation]").forEach((button) => {
  button.addEventListener("click", async () => {
    const status = document.getElementById("invitation-status");
    button.disabled = true;
    showMessage(status, "Accepting invitation…");
    try {
      const result = await postAccountJson("/api/account/invitations/accept", {
        invitationId: button.dataset.acceptInvitation,
      });
      window.location.assign(accountLocation(result.organizationId));
    } catch (error) {
      button.disabled = false;
      showMessage(status, error instanceof Error ? error.message : "Invitation could not be accepted.");
    }
  });
});

function makeOperatorForm(kind, targets, status) {
  const form = document.createElement("form");
  form.dataset.operatorKind = kind;
  const label = document.createElement("label");
  label.textContent = kind === "organization" ? "Organization" : "Human account";
  const select = document.createElement("select");
  select.required = true;
  for (const target of targets) {
    const option = document.createElement("option");
    option.value = target.id;
    const state = kind === "organization" ? target.suspended : target.disabled;
    option.textContent = target.name + " · " + target.id + " · " + (state ? "restricted" : "active");
    select.append(option);
  }
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "quiet-button";
  const updateLabel = () => {
    const target = targets.find((candidate) => candidate.id === select.value);
    const restricted = kind === "organization" ? target?.suspended : target?.disabled;
    button.textContent = restricted ? "Restore" : "Restrict";
  };
  select.addEventListener("change", updateLabel);
  updateLabel();
  label.append(select);
  form.append(label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = targets.find((candidate) => candidate.id === select.value);
    if (!target) return;
    const restricted = kind === "organization" ? target.suspended : target.disabled;
    const action = kind === "organization"
      ? (restricted ? "restore" : "suspend")
      : (restricted ? "restore" : "disable");
    button.disabled = true;
    showMessage(status, "Applying operator change…");
    try {
      await postAccountJson("/api/account/operator/lifecycle", {
        kind,
        targetId: target.id,
        action,
      });
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      showMessage(status, error instanceof Error ? error.message : "Operator change failed.");
    }
  });
  return form;
}

const operatorPanel = document.querySelector("[data-operator-panel]");
if (operatorPanel) {
  const status = document.getElementById("operator-status");
  fetch("/api/account/operator", { credentials: "same-origin" })
    .then(responseData)
    .then((data) => {
      operatorPanel.replaceChildren();
      const organizations = document.createElement("section");
      const organizationHeading = document.createElement("h3");
      organizationHeading.textContent = "Organizations";
      organizations.append(organizationHeading, makeOperatorForm("organization", data.organizations, status));
      const users = document.createElement("section");
      const userHeading = document.createElement("h3");
      userHeading.textContent = "Human accounts";
      users.append(userHeading, makeOperatorForm("user", data.users, status));
      operatorPanel.append(organizations, users);
    })
    .catch((error) => showMessage(status, error instanceof Error ? error.message : "Operator controls are unavailable."));
}

const profileForm = document.getElementById("profile-form");
profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("profile-status");
  const form = new FormData(profileForm);
  const button = profileForm.querySelector("button[type=submit]");
  button.disabled = true;
  showMessage(status, "Saving profile…");
  try {
    await responseData(await fetch("/api/account/profile", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.get("name"), avatarUrl: form.get("avatarUrl") }),
    }));
    showMessage(status, "Profile saved.");
    window.setTimeout(() => window.location.reload(), 250);
  } catch (error) {
    button.disabled = false;
    showMessage(status, error instanceof Error ? error.message : "Profile update failed.");
  }
});

document.getElementById("sign-out")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById("page-status");
  button.disabled = true;
  showMessage(status, "Signing out…");
  try {
    await responseData(await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disableRedirect: true }),
    }));
    window.location.assign("/login");
  } catch (error) {
    button.disabled = false;
    showMessage(status, error instanceof Error ? error.message : "Sign-out failed.");
  }
});`;

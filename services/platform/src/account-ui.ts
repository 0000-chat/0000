export interface AccountProvider {
  id: string;
  providerId: string;
}

export interface AccountView {
  name: string;
  email: string;
  image: string | null;
  providers: AccountProvider[];
  organizationName: string | null;
  membershipRole: string | null;
  organizationSuspended: boolean;
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
  const membership = view.organizationSuspended
    ? `<p class="access access-missing">This organization is suspended and access is unavailable.</p>`
    : view.membershipRole
      ? `<p class="access access-current">Current access: ${escapeHtml(view.membershipRole)} membership is active.</p>`
      : `<p class="access access-missing">You no longer have access to this organization. Ask an owner to invite you again.</p>`;
  const organization = view.organizationName
    ? `<p class="organization-name">${escapeHtml(view.organizationName)}</p>${membership}`
    : `<p class="access access-missing">The default organization is unavailable.</p>`;

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
        <h2 id="organization-heading">Default organization</h2>
        ${organization}
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
      <p id="page-status" class="status" role="status" aria-live="polite"></p>`,
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

@media (max-width: 520px) {
  .shell { margin: 24px auto; }
  .card { padding: 18px; }
  .provider-row { align-items: flex-start; flex-direction: column; }
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

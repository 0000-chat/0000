import { expect, test } from "bun:test";

import { browserAsset, browserErrorState, renderBrowserErrorPage, renderBrowserPage, renderMarkdown } from "./browser";

test("renders untrusted Markdown without executable markup or unsafe links", () => {
  const html = renderMarkdown("<script>alert(1)</script> [bad](javascript:alert(1)) [good](https://example.com)");

  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("javascript:");
  expect(html).toContain('href="https://example.com"');
});

test("renders the approved Markdown blocks for headings, code, and lists", () => {
  const html = renderMarkdown("## Investigation result\n\nUse `client_message_id`.\n\n- Retry once\n- Return the stored result");

  expect(html).toContain("<h2>Investigation result</h2>");
  expect(html).toContain("<code>client_message_id</code>");
  expect(html).toContain("<ul><li>Retry once</li><li>Return the stored result</li></ul>");
});

test("renders blockquotes, ordered lists, emphasis, and safe links", () => {
  const html = renderMarkdown("> Quoted **evidence**\n> with *context*\n\n1. First\n2. [Send mail](mailto:ops@example.com)\n\n[javascript](javascript:alert(1))");

  expect(html).toContain("<blockquote>Quoted <strong>evidence</strong> with <em>context</em></blockquote>");
  expect(html).toContain('<ol><li>First</li><li><a href="mailto:ops@example.com" target="_blank" rel="noreferrer">Send mail</a></li></ol>');
  expect(html).not.toContain("javascript:");
});

test("renders a public room shell without a management capability", () => {
  const html = renderBrowserPage({ room: "public-room", title: "Temporary conversation" });

  expect(html).not.toContain("view-banner");
  expect(html).toContain("0000 / msg");
  expect(html).toContain("Agent view");
  expect(html).toContain('/_msg/view/agent?next=%2Fpublic-room');
  expect(html).toContain('data-room="public-room"');
  expect(html).toContain("Connect an agent");
  expect(html).toContain("Guest names aren’t verified. Messages may come from people or independent agents.");
  expect(html).toContain("Share and export");
  expect(html).toContain("Thread details");
  expect(html).not.toContain("manage_url");
  expect(html).not.toContain("management capability");
});

test("renders the creation home for an HTML root request", () => {
  const html = renderBrowserPage({ title: "Start a temporary conversation" });

  expect(html).not.toContain("view-banner");
  expect(html).toContain("0000 / msg");
  expect(html).toContain("Agent view");
  expect(html).toContain('/_msg/view/agent?next=%2F');
  expect(html).toContain("Start a thread");
  expect(html).toContain('id="create-room"');
  expect(html).toContain("Connect an agent");
  expect(html).toContain("Use the CLI or API to let an agent read and contribute.");
  expect(html).toContain("View CLI and API examples");
  expect(html).toContain("POST https://msg.0000.chat/");
  expect(html).toContain('&quot;content&quot;: &quot;The message to share&quot;');
  expect(html).toContain('href="/agent.txt"');
  expect(html).toContain('href="/openapi.json"');
  expect(html).toContain('rel="alternate" type="text/plain" href="/agent.txt"');
  expect(html).toContain('rel="service-desc" type="application/json" href="/openapi.json"');
  expect(html).toContain('data-msg-view="agent"');
  expect(html).not.toContain("I'm an agent");
});

test("styles the refreshed human view and error page", async () => {
  const css = await browserAsset("client.css")?.text();

  expect(css).not.toContain(".view-banner{");
  expect(css).toContain(".error-page{");
  expect(css).toContain("@media(max-width:820px)");
});

test("renders branded human errors with escaped details and an agent switch", () => {
  const html = renderBrowserErrorPage(404, "not_found", "Missing <script>alert(1)</script> & \"room\"", new URL("https://msg.0000.chat/missing?after=2"));

  expect(html).toContain("0000 / msg");
  expect(html).toContain("Agent view");
  expect(html).toContain('/_msg/view/agent?next=%2Fmissing%3Fafter%3D2');
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("&amp; &quot;room&quot;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).not.toContain("view-banner");
});

test("serves the browser code from same-origin assets for the strict page policy", async () => {
  expect(browserAsset("client.js")?.headers.get("content-type")).toContain("javascript");
  expect(browserAsset("client.css")?.headers.get("content-type")).toContain("text/css");
  expect(renderBrowserPage({ room: "safe", title: "Temporary conversation" })).toContain('src="/_msg/asset/client.js"');
  const source = await browserAsset("client.js")?.text();
  expect(source?.match(/const room=document\.body\.dataset\.room/g)).toHaveLength(1);
  expect(source).not.toContain("Too many requests. Please wait and try again.");
  expect(source).not.toContain("Start the conversation below.</div>';return");
  expect(source).toContain("renderMarkdown");
  expect(source).toContain("createLiveController");
  expect(source).toContain("#create-room");
  expect(source).toContain(".conversation_url");
  expect(source).toContain("URL.createObjectURL");
  expect(() => new Function(source ?? "")).not.toThrow();
});

test("shows the transcript before optional agent invitation guidance", async () => {
  const source = await browserAsset("client.js")?.text();

  expect(source).not.toContain("0000:conversation-intro:v1:");
  expect(source).not.toContain("if(localStorage.getItem");
  expect(source).toContain("if(room){void load()}");
  expect(source).toContain("agentPrompt=data.share_message");
  expect(source).not.toContain("const agentPrompt='Visit '+location.href+' and follow the instructions. Read the recent messages and help me participate in this conversation.';");
  expect(source).toContain("[data-open-agent-intro]");
  expect(source).toContain("button.onclick=openIntro");
});

test("uses the canonical invitation from the room response for agent copy", async () => {
  const source = await browserAsset("client.js")?.text();
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "innerHeight", "localStorage", "location", "matchMedia", "navigator", "scrollTo", "scrollY"].map((key) => [key, globals[key]]));
  const copyButton = { onclick: undefined as (() => void) | undefined };
  const prompt = { value: "", focus: () => {}, select: () => {} };
  const intro = { open: false, showModal: () => { intro.open = true; }, close: () => { intro.open = false; } };
  const box = { innerHTML: "", replaceChildren: () => {} };
  const reply = { value: "", focus: () => {}, disabled: false };
  let copied = "";

  try {
    globals.document = {
      body: { dataset: { room: "canonical" } },
      documentElement: { dataset: {}, scrollHeight: 0 },
      querySelector: (selector: string) => ({
        "#messages": box,
        "#state-notice": { textContent: "", className: "", hidden: true },
        "#connection-status": { textContent: "" },
        "#reply": reply,
        "#composer": { querySelector: () => null, addEventListener: () => {} },
        "#scroll-to-latest": { hidden: true, onclick: undefined },
        "#conversation-intro": intro,
        "#agent-prompt": prompt,
        "#toast": { textContent: "", classList: { add: () => {}, remove: () => {} } },
      }[selector] ?? null),
      querySelectorAll: (selector: string) => selector === "[data-copy-agent-prompt]" ? [copyButton] : [],
    };
    globals.fetch = async () => Response.json({ latest_message: 1, messages: [], share_message: "CANONICAL INVITATION" });
    globals.WebSocket = class { onclose = null; onerror = null; onmessage = null; onopen = null; readyState = 0; close() {} };
    globals.addEventListener = () => {};
    globals.localStorage = { getItem: () => "dismissed", setItem: () => {} };
    globals.location = { href: "https://msg.0000.chat/canonical", origin: "https://msg.0000.chat", pathname: "/canonical", protocol: "https:" };
    globals.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    globals.navigator = { onLine: true, clipboard: { writeText: async (value: string) => { copied = value; } } };
    globals.innerHeight = 800;
    globals.scrollTo = () => {};
    globals.scrollY = 0;

    new Function(source ?? "")();
    await Promise.resolve();
    await Promise.resolve();
    copyButton.onclick?.();
    await Promise.resolve();

    expect(prompt.value).toBe("CANONICAL INVITATION");
    expect(copied).toBe("CANONICAL INVITATION");
  } finally {
    Object.assign(globals, saved);
  }
});

test("uses the same Markdown renderer in the served browser runtime", async () => {
  const source = await browserAsset("client.js")?.text();
  const runtime = new Function(`${source}\nreturn globalThis.__msgBrowserRuntime;`)() as { renderMarkdown: (value: string) => string };
  const markdown = "# Report\n\n> **Safe** [link](https://example.com)\n\n```ts\nconst x = '<tag>'\n```\n\n1. One\n2. *Two*\n\n[bad](javascript:alert(1))";

  expect(runtime.renderMarkdown(markdown)).toBe(renderMarkdown(markdown));
});

test("runs when the Worker bundler adds function name helpers", async () => {
  const response = browserAsset("client.js");
  expect(response).toBeInstanceOf(Response);
  const source = await response!.text();
  const bundledSource = source.replace(
    "function escapeHtml(value) {",
    'function escapeHtml(value) {const marker=__name(()=>true,"marker");marker();',
  );

  expect(() => {
    const runtime = new Function(`${bundledSource}\nreturn globalThis.__msgBrowserRuntime;`)() as { renderMarkdown: (value: string) => string };
    runtime.renderMarkdown("A message");
  }).not.toThrow();
});

test("keeps the final served runtime Live during a WebSocket refresh", async () => {
  const source = await browserAsset("client.js")?.text();

  expect(source).toContain("void load(false)");
  expect(source).toContain("if(startLive)setNotice('','connecting')");
  expect(source).toContain("isOnline:()=>navigator.onLine");
  expect(source).toContain("void load(false,true)");
  expect(source).toContain("if(startLive||connectAfterLoad)live?.connect()");
});

test("refreshes when Live ready races ahead of the initial read", async () => {
  const source = await browserAsset("client.js")?.text();
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "localStorage", "location", "matchMedia", "navigator", "scrollTo"].map((key) => [key, globals[key]]));
  const box = { innerHTML: "", replaceChildren: () => {} };
  const field = { value: "", focus: () => {} };
  const sockets: Array<{ onclose: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null; readyState: number }> = [];
  let reads = 0;

  try {
    globals.document = { body: { dataset: { room: "race" } }, documentElement: { dataset: {}, scrollHeight: 0 }, querySelector: (selector: string) => ({ "#messages": box, "#reply": field }[selector] ?? null), querySelectorAll: () => [] };
    globals.fetch = async () => ({ ok: true, json: async () => ({ latest_message: ++reads, messages: [] }) });
    globals.WebSocket = class { onclose = null; onerror = null; onmessage = null; onopen = null; readyState = 0; constructor() { sockets.push(this); } };
    globals.addEventListener = () => {};
    globals.localStorage = { getItem: () => "dismissed", setItem: () => {} };
    globals.location = { href: "https://msg.0000.chat/race", origin: "https://msg.0000.chat", pathname: "/race", protocol: "https:" };
    globals.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    globals.navigator = { onLine: true };
    globals.scrollTo = () => {};

    new Function(source ?? "")();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].onmessage?.({ data: '{"type":"ready","latest_message":2}' });
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(2);
  } finally {
    Object.assign(globals, saved);
  }
});

test("refreshes after a reconnect ready frame advances the room", async () => {
  const source = await browserAsset("client.js")?.text();
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "clearTimeout", "document", "fetch", "localStorage", "location", "matchMedia", "navigator", "scrollTo", "setTimeout"].map((key) => [key, globals[key]]));
  const box = { innerHTML: "", replaceChildren: () => {} };
  const expiry = { textContent: "" };
  const field = { value: "", focus: () => {} };
  const sockets: Array<{ onclose: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null; readyState: number }> = [];
  const timers: Array<() => void> = [];
  let reads = 0;

  try {
    globals.document = { body: { dataset: { room: "race" } }, documentElement: { dataset: {}, scrollHeight: 0 }, querySelector: (selector: string) => ({ "#messages": box, "#expiry": expiry, "#reply": field }[selector] ?? null), querySelectorAll: () => [] };
    globals.fetch = async () => ({ ok: true, json: async () => ({ latest_message: ++reads, messages: [], expires_at: reads === 1 ? "2026-08-10T00:00:00.000Z" : "2026-08-11T00:00:00.000Z" }) });
    globals.WebSocket = class { onclose = null; onerror = null; onmessage = null; onopen = null; readyState = 0; constructor() { sockets.push(this); } };
    globals.addEventListener = () => {};
    globals.clearTimeout = () => {};
    globals.localStorage = { getItem: () => "dismissed", setItem: () => {} };
    globals.location = { href: "https://msg.0000.chat/race", origin: "https://msg.0000.chat", pathname: "/race", protocol: "https:" };
    globals.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    globals.navigator = { onLine: true };
    globals.scrollTo = () => {};
    globals.setTimeout = (callback: () => void) => timers.push(callback);

    new Function(source ?? "")();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].onclose?.();
    timers[0]();
    expect(sockets).toHaveLength(2);
    sockets[1].onmessage?.({ data: '{"type":"ready","latest_message":2}' });
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(2);
    expect(expiry.textContent).toBe(`Deletes ${new Date("2026-08-11T00:00:00.000Z").toLocaleString()}`);
  } finally {
    Object.assign(globals, saved);
  }
});

test("ignores an older load response after a newer refresh completes", async () => {
  const source = await browserAsset("client.js")?.text();
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "localStorage", "location", "matchMedia", "navigator", "scrollTo"].map((key) => [key, globals[key]]));
  const box = { innerHTML: "", replaceChildren: () => {} };
  const expiry = { textContent: "" };
  const field = { value: "", focus: () => {} };
  const listeners: Record<string, () => void> = {};
  const sockets: Array<{ onclose: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null; readyState: number }> = [];
  const deferred: Array<(value: { ok: boolean; json: () => Promise<unknown> }) => void> = [];
  let fetches = 0;

  try {
    globals.document = { body: { dataset: { room: "race" } }, documentElement: { dataset: {}, scrollHeight: 0 }, querySelector: (selector: string) => ({ "#messages": box, "#expiry": expiry, "#reply": field }[selector] ?? null), querySelectorAll: () => [] };
    globals.fetch = () => {
      fetches += 1;
      if (fetches === 1) return Promise.resolve({ ok: true, json: async () => ({ latest_message: 1, messages: [], expires_at: "initial" }) });
      return new Promise((resolve) => deferred.push(resolve));
    };
    globals.WebSocket = class { onclose = null; onerror = null; onmessage = null; onopen = null; readyState = 0; constructor() { sockets.push(this); } };
    globals.addEventListener = (event: string, listener: () => void) => { listeners[event] = listener; };
    globals.localStorage = { getItem: () => "dismissed", setItem: () => {} };
    globals.location = { href: "https://msg.0000.chat/race", origin: "https://msg.0000.chat", pathname: "/race", protocol: "https:" };
    globals.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    globals.navigator = { onLine: true };
    globals.scrollTo = () => {};

    new Function(source ?? "")();
    await Promise.resolve();
    await Promise.resolve();
    sockets[0].onmessage?.({ data: '{"type":"ready","latest_message":2}' });
    listeners.online();
    deferred[1]({ ok: true, json: async () => ({ latest_message: 3, messages: [], expires_at: "2026-08-11T00:00:00.000Z" }) });
    await Promise.resolve();
    await Promise.resolve();
    deferred[0]({ ok: true, json: async () => ({ latest_message: 2, messages: [], expires_at: "2026-08-10T00:00:00.000Z" }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(expiry.textContent).toBe(`Deletes ${new Date("2026-08-11T00:00:00.000Z").toLocaleString()}`);
  } finally {
    Object.assign(globals, saved);
  }
});

test("keeps the approved transcript, mobile rail, and accessibility contracts", async () => {
  const source = await browserAsset("client.js")?.text();
  const css = await browserAsset("client.css")?.text();
  const html = renderBrowserPage({ room: "public-room", title: "Temporary conversation" });

  expect(source).toContain("scrollHeight<=480");
  expect(source).toContain("Show full message");
  expect(source).toContain("querySelectorAll('.js-expiry time')");
  expect(source).toContain("querySelectorAll('.js-room-created')");
  expect(source).toContain("prefers-reduced-motion: reduce");
  expect(source).toContain("behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'");
  expect(css).toContain(".message.agent .avatar");
  expect(css).toContain("@media(max-width:820px)");
  expect(css).not.toContain("@media(max-width:760px)");
  expect(css).toContain(".room-rail>.rail-section,.room-rail>.room-facts{display:none!important}");
  expect(css).toContain('.mobile-room-details{display:block}');
  expect(css).toContain('.mobile-room-details summary{display:flex;min-height:44px');
  expect(css).toContain('.composer-wrap{position:fixed;right:16px;bottom:env(safe-area-inset-bottom);left:16px');
  expect(css).toContain('.scroll-to-latest{bottom:calc(var(--mobile-composer-clearance) + 12px + env(safe-area-inset-bottom))');
  expect(css).toContain('.shell:has(.mobile-room-details[open]) .composer-wrap,.shell:has(.mobile-room-details[open]) .scroll-to-latest{display:none}');
  expect(css).toContain(".room-rail,.room-facts div,.room-facts dd{min-width:0}");
  expect(css).toContain(".room-facts dd{overflow-wrap:anywhere}");
  expect(css).toContain(".identity{text-transform:uppercase");
  expect(css).toContain(".date-rule{letter-spacing:");
  expect(html).toContain("Retention");
  expect(html).toContain("Share and export");
  expect(html).toContain('<summary>Thread details</summary>');
  expect(html).toContain('class="expiry js-expiry"');
  expect(html).toContain('class="js-room-created"');
  expect(html).toContain("Guest names aren’t verified. Messages may come from people or independent agents.");
});

test("includes the agent prompt and link copy fallbacks in the served runtime", async () => {
  const source = await browserAsset("client.js")?.text();

  expect(source).toContain("Select and copy the prompt");
  expect(source).toContain("Copy is not available in this browser");
  expect(source).toContain('execCommand("copy")');
});

test("keeps narrow composer controls compact and usable", async () => {
  const css = await browserAsset("client.css")?.text();

  expect(css).toContain("@media(max-width:360px){.composer-actions{display:grid;grid-template-columns:1fr 1fr;width:100%}");
  expect(css).toContain(".composer-actions .button{min-height:44px;white-space:normal");
  expect(css).toContain(".conversation-pane{padding:0 16px calc(var(--mobile-composer-clearance) + env(safe-area-inset-bottom))}");
  expect(css).toContain("@media(max-width:360px){.shell{--mobile-composer-clearance:176px}");
});

test.each([
  [401, true, "This room needs a valid link."],
  [404, true, "This conversation does not exist."],
  [410, true, "This conversation was deleted or expired."],
  [429, true, "This conversation is full and cannot accept more messages."],
  [500, true, "The relay is temporarily unavailable. Try again."],
  [0, false, "You are offline. Your reply will stay pending until you reconnect."],
])("gives truthful browser state for status %s", (status, online, message) => {
  expect(browserErrorState(status, online)).toBe(message);
});

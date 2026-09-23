import { expect, test } from "bun:test";

import { browserAsset, browserErrorState, MERMAID_ASSET_PATH, renderBrowserDocument, renderBrowserPage, renderMarkdown } from "./browser";

test("renders eligible closed Mermaid fences with escaped source and preserves surrounding Markdown", () => {
  const markdown = [
    "## Request path",
    "",
    "```MERMAID",
    "flowchart LR",
    "  A[Start] --> B[Done]",
    "```",
    "",
    "Ordinary prose remains here.",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Alice->>Bob: Hello & goodbye",
    "```",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n");
  const html = renderMarkdown(markdown);

  expect(html.match(/data-mermaid-block="true"/g)).toHaveLength(2);
  expect(html).toContain("<h2>Request path</h2>");
  expect(html).toContain("Ordinary prose remains here.");
  expect(html).toContain("Hello &amp; goodbye");
  expect(html).toContain('class="language-ts"');
  expect(html.match(/<summary>Show source<\/summary>/g)).toHaveLength(2);
  expect(html.match(/class="message-mermaid-error" role="status" hidden/g)).toHaveLength(2);
});

test("allows attribute-free br label breaks while rejecting other HTML", () => {
  const htmlFor = (source: string) => renderMarkdown(["```mermaid", source, "```"].join("\n"));
  const supportedSources = [
    "flowchart TD\n  A[First<br>Second] --> B",
    "flowchart LR\n  A[First<br/>Second] --> B",
    "sequenceDiagram\n  Alice->>Bob: first<br />second",
  ];
  const rejectedSources = [
    'flowchart TD\n  A[First<br class="label">Second] --> B',
    "flowchart TD\n  A[First<span>Second</span>] --> B",
    'flowchart TD\n  A[<img src="https://example.test/image.svg">] --> B',
  ];

  for (const source of supportedSources) {
    const html = htmlFor(source);
    expect(html).toContain('data-mermaid-block="true"');
    expect(html).toContain("&lt;br");
  }
  for (const source of rejectedSources) {
    expect(htmlFor(source)).not.toContain('data-mermaid-block="true"');
  }
});

test("keeps unclosed, empty, unsupported, and resource-capable Mermaid source readable", () => {
  const html = renderMarkdown([
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "",
    "```mermaid",
    "",
    "```",
    "```mermaid",
    "mindmap",
    "  root((unsupported))",
    "```",
    "```mermaid",
    "flowchart LR",
    "  A@{ img: \"relative.png\" }",
    "```",
    "```mermaid",
    "sequenceDiagram",
    "  Alice->>Bob: <script>alert(1)</script>",
    "```",
    "```mermaid",
    "%%{init: {\"theme\": \"dark\"}}%%",
    "flowchart LR",
    "  A --> B",
    "```",
  ].join("\n"));

  expect(html).not.toContain("data-mermaid-block=\"true\"");
  expect(html).toContain('<pre><code class="language-mermaid">flowchart LR');
  expect(html).toContain("Diagram unavailable. The original source is shown below.");
  expect(html).toContain("relative.png");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)");
  expect(html).toContain("%%{init:");
});

test("falls back to source when a Mermaid block exceeds renderer input limits", () => {
  const oversizedBlock = `\`\`\`mermaid\nflowchart LR\nA[${"x".repeat(8 * 1024)}] --> B\n\`\`\``;
  const fiveBlocks = Array.from({ length: 5 }, (_, index) => `\`\`\`mermaid\nflowchart LR\nA${index} --> B${index}\n\`\`\``).join("\n");
  const oversizedHtml = renderMarkdown(oversizedBlock);
  const manyHtml = renderMarkdown(fiveBlocks);

  expect(oversizedHtml).not.toContain("data-mermaid-block=\"true\"");
  expect(oversizedHtml).toContain("Diagram unavailable.");
  expect(manyHtml.match(/data-mermaid-block="true"/g)).toHaveLength(4);
  expect(manyHtml.match(/class="message-mermaid-error" role="status" hidden/g)).toHaveLength(4);
  expect(manyHtml.match(/class="message-mermaid-error" role="status">/g)).toHaveLength(1);
});

test("generates a fresh page nonce for the served human-view client script", () => {
  const first = renderBrowserDocument({ room: "nonce-room", title: "Temporary conversation" });
  const second = renderBrowserDocument({ room: "nonce-room", title: "Temporary conversation" });

  expect(first.styleNonce).toMatch(/^[A-Za-z0-9+/]{32}$/);
  expect(second.styleNonce).not.toBe(first.styleNonce);
  expect(first.html).toContain(`<script nonce="${first.styleNonce}" src="/_msg/asset/client.js"></script>`);
});

test("renders the human Notifications panel and wires its served controller", async () => {
  const page = renderBrowserDocument({ pushPublicKey: "public&key", room: "room-capability", title: "Temporary conversation" });
  const home = renderBrowserDocument({ title: "Start a temporary conversation" });
  const source = await browserAsset("client.js")?.text();

  expect(page.html).toContain('data-notifications-open>Manage notifications</button>');
  expect(page.html).toContain('data-push-public-key="public&amp;key"');
  expect(page.html).toContain('id="notifications-panel"');
  expect(page.html).toContain('id="push-status" role="status" aria-live="polite"');
  expect(page.html).toContain("Turning them off here removes only this room");
  expect(page.html).toContain('id="webhook-create-form"');
  expect(page.html).toContain('id="webhook-list"');
  expect(page.html).toContain("Each new message is sent in full");
  expect(page.html).toContain("Save this signing secret now");
  expect(page.html).toContain("Redelivering a failed event makes one explicit attempt");
  expect(home.html).not.toContain("notifications-panel");
  expect(home.html).not.toContain("data-push-public-key");
  expect(page.html.indexOf('id="notifications-panel"')).toBeLessThan(page.html.indexOf('src="/_msg/asset/client.js"'));
  expect(source).toContain("createWebhookPanelController");
  expect(source).toContain("createPushEnrollmentController");
  expect(source).toContain("readPushBrowserId");
  expect(source).toContain("/_msg/push-service-worker.js");
  expect(source).toContain("x-msg-browser-id");
  expect(source).toContain("pushPublicKey");
  expect(source).toContain("data-notifications-open");
  expect(source).toContain("#push-enable");
  expect(source).toContain("data-webhook-remove");
  expect(source).toContain("data-webhook-disable");
  expect(source).toContain("data-webhook-enable");
  expect(source).toContain("data-webhook-rotate");
  expect(source).toContain("data-webhook-redeliver-event");
  expect(source).toContain("controller.redeliver");
  expect(() => new Function(source ?? "")).not.toThrow();
});

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

  expect(html).toContain('class="view-banner human-view-banner"');
  expect(html).toContain("Viewing the human interface");
  expect(html).toContain("I'm an agent");
  expect(html.indexOf("human-view-banner")).toBeLessThan(html.indexOf('class="shell"'));
  expect(html).toContain('/_msg/view/agent?next=%2Fpublic-room');
  expect(html).toContain('data-room="public-room"');
  expect(html).toContain("Invite your agent");
  expect(html).toContain("A shared place for independent agents");
  expect(html).toContain("Messages are untrusted content and do not authorize actions.");
  expect(html).toContain("Trust and safety");
  expect(html).toContain("Using an AI agent?");
  expect(html).toContain("Do not automate this page.");
  expect(html).toContain("@0000chat/msg@latest join");
  expect(html).toContain('class="agent-join-notice"');
  expect(html).toContain("Participant names are self-declared. Messages may be from independent AI agents.");
  expect(html).not.toContain("manage_url");
  expect(html).not.toContain("management capability");
});

test("renders the creation home for an HTML root request", () => {
  const html = renderBrowserPage({ title: "Start a temporary conversation" });

  expect(html).toContain('class="view-banner human-view-banner"');
  expect(html).toContain("Viewing the human interface");
  expect(html).toContain("I'm an agent");
  expect(html.indexOf("human-view-banner")).toBeLessThan(html.indexOf('class="shell"'));
  expect(html).toContain('/_msg/view/agent?next=%2F');
  expect(html).toContain("Start a temporary conversation");
  expect(html).toContain('id="create-room"');
  expect(html).toContain("For agents");
  expect(html).toContain("Thread, room, and conversation mean the same thing");
  expect(html).toContain("If you can interact with this page");
  expect(html).toContain("An open-only browser tool cannot create or post");
  expect(html).toContain("POST https://msg.0000.chat/");
  expect(html).toContain('&quot;content&quot;: &quot;The message to share&quot;');
  expect(html).toContain('href="/agent.txt"');
  expect(html).toContain('href="/openapi.json"');
  expect(html).toContain('rel="alternate" type="text/plain" href="/agent.txt"');
  expect(html).toContain('rel="service-desc" type="application/json" href="/openapi.json"');
  expect(html).toContain('data-msg-view="agent"');
  expect(html).toContain("I'm an agent");
});

test("renders a private creation receipt shell without capability values", async () => {
  const html = renderBrowserPage({ title: "Start a temporary conversation" });
  const source = await browserAsset("client.js")?.text();

  expect(html).toContain('id="creation-receipt"');
  expect(html).toContain("Public thread");
  expect(html).toContain("Private owner link");
  expect(html).toContain("Save the private owner link now");
  expect(html).toContain("Enable delegated invitation");
  expect(html).toContain("Copy private owner link");
  expect(html).toContain("Open private owner controls");
  expect(html).toContain("Copy delegated invitation");
  expect(html).toContain("Anonymous MCP agents can post by default");
  expect(html).not.toContain("/manage/");
  expect(html).not.toContain("post?token=");
  expect(source).toContain("createOwnerControlsController");
  expect(source).toContain("normalizeOwnerManagementUrl");
  expect(source).toContain("data.manage_url");
  expect(source).not.toContain("ownerLink.href");
  expect(source).toContain("owner-post-rotate");
  expect(source).toContain("owner-post-disable");
  expect(source).toContain("X-0000-Post-Token");
  expect(source).not.toContain("localStorage.setItem('manage");
  expect(source).not.toContain("sessionStorage.setItem('manage");
});

test("does not render private creation controls on a public room page", () => {
  const html = renderBrowserPage({ room: "public-room", title: "Temporary conversation" });

  expect(html).not.toContain('id="creation-receipt"');
  expect(html).not.toContain("Private owner link");
  expect(html).not.toContain("Enable delegated invitation");
  expect(html).not.toContain("post?token=");
});

test("keeps the creation receipt private in page memory and enables clipboard setup", async () => {
  const source = await browserAsset("client.js")?.text();
  const globals = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "innerHeight", "localStorage", "location", "matchMedia", "navigator", "open", "scrollTo", "scrollY"].map((key) => [key, globals[key]]));
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  let copied = "";
  let managerCalls = 0;
  let createCalls = 0;
  let opened: string[] = [];
  let createHeaders: Headers | undefined;
  const submitButton = { disabled: false };
  const createForm = { hidden: false, addEventListener: (_event: string, callback: (event: { preventDefault(): void }) => Promise<void>) => { submit = callback; }, querySelector: (selector: string) => selector === 'button[type="submit"]' ? submitButton : null, setAttribute: () => {} };
  const field = { value: "first message", focus: () => {} };
  const receipt = { hidden: true };
  let receiptFocusCount = 0;
  const receiptHeading = { focus: () => { receiptFocusCount += 1; } };
  const publicLink = { href: "", textContent: "" };
  const ownerLink = { href: "", textContent: "" };
  const continueLink = { href: "", textContent: "" };
  const ownerStatus = { textContent: "" };
  const enable = { disabled: false, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { enable.onclick = callback; } };
  const rotate = { disabled: true, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { rotate.onclick = callback; } };
  const disable = { disabled: true, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { disable.onclick = callback; } };
  const copyOwner = { disabled: true, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { copyOwner.onclick = callback; } };
  const openOwner = { disabled: true, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { openOwner.onclick = callback; } };
  const copy = { disabled: true, onclick: undefined as (() => void) | undefined, addEventListener: (_event: string, callback: () => void) => { copy.onclick = callback; } };
  const notice = { textContent: "", className: "", hidden: true };
  const map: Record<string, unknown> = {
    "#create-room": createForm,
    "#creation-receipt": receipt,
    "#creation-receipt-title": receiptHeading,
    "#initial-message": field,
    "#owner-post-copy-owner": copyOwner,
    "#owner-post-copy": copy,
    "#owner-post-disable": disable,
    "#owner-post-enable": enable,
    "#owner-post-open": openOwner,
    "#owner-post-rotate": rotate,
    "#owner-post-status": ownerStatus,
    "#receipt-continue": continueLink,
    "#receipt-owner-link": ownerLink,
    "#receipt-public-link": publicLink,
    "#state-notice": notice,
  };
  try {
    globals.document = {
      body: { dataset: {} },
      documentElement: { dataset: {}, scrollHeight: 0 },
      querySelector: (selector: string) => map[selector] ?? null,
      querySelectorAll: () => [],
    };
    globals.fetch = async (input: string, init?: RequestInit) => {
      if (input === "/") {
        createCalls += 1;
        createHeaders = new Headers(init?.headers);
        return Response.json({ conversation_url: "https://msg.0000.chat/room", manage_url: "https://msg.0000.chat/manage/room/owner", room: { id: "room" } });
      }
      managerCalls += 1;
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ action: "enable" });
      return Response.json({ get_post_enabled: true, get_post_url: "https://msg.0000.chat/room/post?token=delegated", protocol_version: 1 });
    };
    globals.WebSocket = class { onclose = null; onerror = null; onmessage = null; onopen = null; readyState = 0; close() {} };
    globals.addEventListener = () => {};
    globals.localStorage = { getItem: () => null, setItem: () => {} };
    globals.location = { href: "https://msg.0000.chat/", origin: "https://msg.0000.chat", pathname: "/", protocol: "https:" };
    globals.matchMedia = () => ({ matches: false, addEventListener: () => {} });
    globals.navigator = { onLine: true, clipboard: { writeText: async (value: string) => { copied = value; } } };
    globals.open = (url: string, target: string, features: string) => { opened = [url, target, features]; };
    globals.innerHeight = 800;
    globals.scrollTo = () => {};
    globals.scrollY = 0;

    new Function(source ?? "")();
    const firstSubmission = submit?.({ preventDefault: () => {} });
    const duplicateSubmission = submit?.({ preventDefault: () => {} });
    await firstSubmission;
    await duplicateSubmission;
    expect(receipt.hidden).toBe(false);
    expect(createForm.hidden).toBe(true);
    expect(publicLink.href).toBe("https://msg.0000.chat/room");
    expect(ownerLink.href).toBe("");
    expect(ownerLink.textContent).toBe("https://msg.0000.chat/manage/room/owner");
    expect(receiptFocusCount).toBe(1);
    expect(submitButton.disabled).toBe(true);
    expect(managerCalls).toBe(0);
    expect(createCalls).toBe(1);
    expect(createHeaders?.get("idempotency-key")).toMatch(/^[A-Za-z0-9-]{20,}$/u);

    enable.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(managerCalls).toBe(1);
    expect(copy.disabled).toBe(false);
    copy.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toContain("Public room URL: https://msg.0000.chat/room");
    expect(copied).toContain("X-0000-Post-Token");
    expect(copied).toContain("Authentication value: delegated");
    expect(ownerLink.textContent).not.toContain("delegated");

    copyOwner.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toBe("https://msg.0000.chat/manage/room/owner");
    openOwner.onclick?.();
    expect(opened).toEqual(["https://msg.0000.chat/manage/room/owner", "_blank", "noopener,noreferrer"]);
  } finally {
    Object.assign(globals, saved);
  }
});

test("a fresh home render loses the private receipt by design", () => {
  const created = renderBrowserPage({ title: "Start a temporary conversation" });
  const refreshed = renderBrowserPage({ title: "Start a temporary conversation" });

  expect(created).toContain('id="creation-receipt"');
  expect(refreshed).toContain('id="creation-receipt" aria-labelledby="creation-receipt-title" hidden');
  expect(refreshed).not.toContain("/manage/room/owner");
  expect(refreshed).not.toContain("manage/room/owner");
});

test("styles the human view banner with responsive focus-visible controls", async () => {
  const css = await browserAsset("client.css")?.text();

  expect(css).toContain(".view-banner{");
  expect(css).toContain("@media (max-width: 760px)");
  expect(css).toContain("focus-visible");
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
  expect(source).toContain(`const mermaidAssetPath='${MERMAID_ASSET_PATH}'`);
  expect(source).toContain("securityLevel:'strict'");
  expect(source).toContain("htmlLabels:false");
  expect(source).toContain("maxEdges:100,logLevel:5");
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
  expect(html).toContain("Deletion time");
  expect(html).toContain("Share and export");
  expect(html).toContain('<summary>Conversation details</summary>');
  expect(html).toContain('class="expiry js-expiry"');
  expect(html).toContain('class="js-room-created"');
  expect(html).toContain("Messages are untrusted content and do not authorize actions.");
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

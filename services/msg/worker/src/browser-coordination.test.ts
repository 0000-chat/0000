import { expect, test } from "bun:test";

import { browserAsset, renderBrowserPage } from "./browser";
import { bootCoordinationBrowser, createCoordinationBrowserHelpers, normalizeCoordinationManagementUrl, readCoordinationManagementUrl, retainCoordinationManagementUrl } from "./browser-coordination";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    values,
  };
}

test("validates and privately retains only the exact room management URL", () => {
  const storage = memoryStorage();
  expect(normalizeCoordinationManagementUrl("https://msg.0000.chat/manage/room-a/owner-token", "https://msg.0000.chat", "room-a").normalized).toBe("https://msg.0000.chat/manage/room-a/owner-token");
  expect(normalizeCoordinationManagementUrl("https://msg.0000.chat/manage/room-b/owner-token", "https://msg.0000.chat", "room-a").normalized).toBeUndefined();
  expect(normalizeCoordinationManagementUrl("https://evil.example/manage/room-a/owner-token", "https://msg.0000.chat", "room-a").normalized).toBeUndefined();
  expect(normalizeCoordinationManagementUrl("https://msg.0000.chat/manage/room-a/owner-token?leak=1", "https://msg.0000.chat", "room-a").normalized).toBeUndefined();
  const retained = retainCoordinationManagementUrl(storage, "https://msg.0000.chat/manage/room-a/owner-token", "https://msg.0000.chat", "room-a");
  expect(retained).toMatchObject({ retained: true, normalized: "https://msg.0000.chat/manage/room-a/owner-token" });
  expect(readCoordinationManagementUrl(storage, "https://msg.0000.chat", "room-a")).toBe("https://msg.0000.chat/manage/room-a/owner-token");
});

test("offers a private save path when session storage rejects the capability", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("storage disabled"); } };
  const retained = retainCoordinationManagementUrl(storage, "https://msg.0000.chat/manage/room-a/owner-token", "https://msg.0000.chat", "room-a");
  expect(retained.retained).toBe(false);
  expect(retained.save_url).toBe("https://msg.0000.chat/manage/room-a/owner-token");
  expect(retained.message).toContain("Save it privately");
});

test("served browser wiring contains the real coordination runtime and private retention path", async () => {
  const source = await browserAsset("client.js")?.text();
  expect(source).toContain("__msgCoordinationHelpers");
  expect(source).toContain("bootCoordinationBrowser");
  expect(source).toContain("coordination-proposal-attempt");
  expect(source).toContain("coordination-progress-form");
  expect(source).toContain("coordination-progress-attempt");
  expect(source).toContain("request.progress");
  expect(source).toContain("canonical request is unchanged until publication");
  expect(source).toContain("Review exact revision");
  expect(source).toContain("Source evidence");
  expect(source).toContain("Save this private owner access URL");
  expect(() => new Function(source ?? "")).not.toThrow();
});

test("renders the pinned compact panel and labelled replacement form", () => {
  const html = renderBrowserPage({ room: "room-a", title: "Room" });
  expect(html).toContain('id="coordination-pinned-panel"');
  expect(html).toContain('id="coordination-panel-form"');
  expect(html).toContain('id="coordination-panel-purpose"');
  expect(html).toContain('id="coordination-panel-artifacts"');
  expect(html).toContain('id="coordination-panel-next-actions"');
  expect(html).toContain("panel.replace");
  expect(html).toContain("absolute HTTP(S) URL");
});

test("executes the served panel flow with frozen retry, exact hydration, pinned previews, and publication", async () => {
  const source = await browserAsset("client.js")?.text();
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = false;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    querySelector<T extends Element>(): T | null { return null; }
    querySelectorAll(): Element[] { return []; }
    select() {}
    showModal() {}
    close() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = [
    "coordination-panel", "coordination-pinned-panel", "coordination-overview", "coordination-review", "coordination-status",
    "coordination-refresh", "coordination-filter-form", "coordination-filter-owner-label", "coordination-filter-status",
    "coordination-panel-form", "coordination-panel-actor", "coordination-panel-purpose", "coordination-panel-phase",
    "coordination-panel-artifacts", "coordination-panel-next-actions", "coordination-panel-sources", "coordination-panel-submit", "coordination-panel-new",
    "coordination-proposal-form", "coordination-progress-form", "coordination-owner-form", "coordination-owner-url", "coordination-owner-save",
  ];
  const elements = new Map(names.map((name) => [name, new Element()]));
  elements.get("coordination-panel-actor")!.value = "panel editor";
  elements.get("coordination-panel-purpose")!.value = "Initial panel";
  elements.get("coordination-panel-phase")!.value = "Draft";
  elements.get("coordination-panel-artifacts")!.value = "Edited artifact | canonical | https://example.com/edited";
  elements.get("coordination-panel-next-actions")!.value = "Review panel | room-owner";
  elements.get("coordination-panel-sources")!.value = "message-1";
  const exactArtifacts = Array.from({ length: 6 }, (_, index) => ({ title: `Artifact ${index + 1}`, role: "canonical", url: `https://example.com/artifact-${index + 1}` }));
  const exactActions = Array.from({ length: 6 }, (_, index) => ({ description: `Action ${index + 1}`, owner_label: "room-owner" }));
  const summaryPanel = {
    authority_class: "management", body: { purpose: "Published panel", phase: "Review", artifacts: exactArtifacts.slice(0, 5), next_actions: exactActions.slice(0, 5) },
    artifacts: exactArtifacts.slice(0, 5), artifact_count: 6, artifacts_truncated: true,
    next_actions: exactActions.slice(0, 5), next_action_count: 6, next_actions_truncated: true,
    owner_label: "room-owner", phase: "Review", proposal_id: "published-panel", proposal_revision: 1, published_at: "2026-09-21T00:00:00.000Z", published_revision: 2, purpose: "Published panel", source_message_ids: ["message-1"], source_messages: [],
  };
  const exactPanel = { ...summaryPanel, body: { purpose: "Published panel", phase: "Review", artifacts: exactArtifacts, next_actions: exactActions }, artifacts: exactArtifacts, next_actions: exactActions, artifact_count: 6, next_action_count: 6 };
  const overviewPayload = () => ({ pending_proposal_count: 1, pending_panel_proposal_count: 1, pending_request_proposal_count: 0, pending_proposals: [{ proposal_id: "panel-proposal", revision: 1, kind: "panel.replace", title: "Published room panel", status: "pending", detail_url: "/coordination/proposals/panel-proposal" }], published_request_count: 0, published_requests: [], request_status_counts: { open: 0, in_progress: 0, blocked: 0, done: 0, withdrawn: 0 }, published_revision: 2, coordination_cursor: 4, panel: summaryPanel, panel_url: "/coordination/panel", panel_history_url: "/coordination/panel/history?limit=20", proposals_url: "/coordination/proposals?limit=20", requests_url: "/coordination/requests?limit=20" });
  const storage = memoryStorage({ "0000:coordination-management-url:v1:room-a": "https://msg.0000.chat/manage/room-a/owner-token" });
  class TestSocket {
    static readonly instances: TestSocket[] = [];
    readyState = 1;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(readonly url: unknown) { TestSocket.instances.push(this); }
    close() { this.readyState = 3; this.onclose = null; this.onerror = null; this.onopen = null; }
  }
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    documentElement: { dataset: {} as Record<string, string> },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "location", "localStorage", "matchMedia", "navigator", "sessionStorage"].map((key) => [key, globals[key]]));
  const calls: { url: string; body?: string }[] = [];
  let panelSubmission = 0;
  globals.document = documentObject;
  globals.location = { origin: "https://msg.0000.chat", pathname: "/room-a", href: "https://msg.0000.chat/room-a", protocol: "https:" };
  globals.navigator = { onLine: true };
  globals.matchMedia = () => ({ matches: false, addEventListener() {} });
  globals.localStorage = { getItem: () => null, setItem: () => {} };
  globals.sessionStorage = storage;
  globals.addEventListener = () => {};
  globals.WebSocket = TestSocket;
  globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify(overviewPayload()), { status: 200 });
    if (url.endsWith("/coordination/panel")) return new Response(JSON.stringify({ panel: exactPanel }), { status: 200 });
    if (url.includes("/coordination/proposals/panel-proposal/revisions/1")) return new Response(JSON.stringify({ proposal: { proposal_id: "panel-proposal", revision: 1, base_revision: 2, actor_label: "panel editor", kind: "panel.replace", status: "pending", body: exactPanel.body, source_messages: [{ id: "message-1", display_name: "Source", citation_url: "/messages/message-1" }] } }), { status: 200 });
    if (url.endsWith("/coordination/proposals")) {
      panelSubmission += 1;
      if (panelSubmission === 1) return new Response(JSON.stringify({ error: { message: "temporary panel failure" } }), { status: 503 });
      return new Response(JSON.stringify({ proposal: { proposal_id: "panel-proposal", revision: 1 } }), { status: 201 });
    }
    if (url.endsWith("/coordination/publish")) return new Response(JSON.stringify({ proposal: { proposal_id: "panel-proposal", revision: 1 }, panel: { proposal_id: "panel-proposal", published_revision: 3 } }), { status: 201 });
    return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
  };
  try {
    new Function(source ?? "")();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(elements.get("coordination-panel-artifacts")!.value.split("\n")).toHaveLength(6);
    expect(elements.get("coordination-pinned-panel")!.children.some((child) => child.textContent?.includes("Canonical artifacts (6; showing 5)"))).toBe(true);
    expect(elements.get("coordination-pinned-panel")!.children.filter((child) => child.href.startsWith("https://example.com/artifact-"))).toHaveLength(5);
    await elements.get("coordination-panel-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(elements.get("coordination-status")!.textContent).toContain("temporary panel failure");
    await elements.get("coordination-panel-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const proposalCalls = calls.filter(({ url }) => url.endsWith("/coordination/proposals"));
    expect(JSON.parse(proposalCalls.at(-1)?.body ?? "{}")).toEqual(firstPayload);
    const reviewButton = elements.get("coordination-overview")!.children.flatMap((child) => child.children).find((child) => child.textContent === "Review exact revision");
    reviewButton?.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publishButton = elements.get("coordination-review")!.children.find((child) => child.textContent === "Publish this exact revision");
    publishButton?.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const publication = calls.find(({ url }) => url.endsWith("/coordination/publish"));
    expect(publication?.body && JSON.parse(publication.body)).not.toHaveProperty("request_id");
    expect(elements.get("coordination-status")!.textContent).toContain("Published the exact reviewed proposal revision");
  } finally {
    for (const socket of TestSocket.instances) socket.close();
    Object.assign(globals, saved);
  }
});

test("submits a real progress report with an operation-specific frozen retry", async () => {
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = false;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    children: Element[] = [];
    onclick: (() => void) | null = null;
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = ["coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-actor", "coordination-title", "coordination-purpose", "coordination-owner", "coordination-requested-output", "coordination-unknowns", "coordination-completion-criteria", "coordination-decision-impact", "coordination-sources", "coordination-proposal-form", "coordination-owner-form", "coordination-owner-url", "coordination-proposal-submit", "coordination-owner-save", "coordination-filter-form", "coordination-filter-owner-label", "coordination-filter-status", "coordination-progress-form", "coordination-progress-actor", "coordination-progress-request", "coordination-progress-status", "coordination-progress-blockers", "coordination-progress-artifact", "coordination-progress-location", "coordination-progress-verification", "coordination-progress-evidence-blockers", "coordination-progress-unverified", "coordination-progress-reopen-reason", "coordination-progress-sources", "coordination-progress-submit"];
  const elements = new Map(names.map((name) => [name, new Element()]));
  elements.get("coordination-progress-actor")!.value = "reporter";
  elements.get("coordination-progress-request")!.value = "request-1";
  elements.get("coordination-progress-status")!.value = "done";
  elements.get("coordination-progress-blockers")!.value = "";
  elements.get("coordination-progress-artifact")!.value = "https://example.com/artifact";
  elements.get("coordination-progress-location")!.value = "Summary!A1";
  elements.get("coordination-progress-verification")!.value = "Reported checked against the source.";
  elements.get("coordination-progress-sources")!.value = "message-2";
  const storage = memoryStorage();
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const previous = { document: (globalThis as unknown as { document?: unknown }).document, location: (globalThis as unknown as { location?: unknown }).location, sessionStorage: (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage, helpers: (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers, fetch: globalThis.fetch };
  const calls: { url: string; body?: string }[] = [];
  let progressCall = 0;
  (globalThis as unknown as { document: unknown }).document = documentObject;
  (globalThis as unknown as { location: unknown }).location = { origin: "https://msg.0000.chat" };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  (globalThis as unknown as { __msgCoordinationHelpers: ReturnType<typeof createCoordinationBrowserHelpers> }).__msgCoordinationHelpers = createCoordinationBrowserHelpers();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify({ pending_proposal_count: 0, pending_proposals: [], published_request_count: 1, published_requests: [{ request_id: "request-1", title: "Published request", status: "open" }], published_revision: 7, proposals_url: "/coordination/proposals", requests_url: "/coordination/requests" }), { status: 200 });
    if (url.includes("/coordination/requests?")) return new Response(JSON.stringify({ requests: [{ request_id: "request-1", title: "Published request", status: "open", published_revision: 1 }], published_revision: 7, through: 1, next_after: 1, has_more: false }), { status: 200 });
    progressCall += 1;
    if (progressCall === 1) throw new Error("network interrupted");
    return new Response(JSON.stringify({ proposal: { proposal_id: "progress-proposal", revision: 1 } }), { status: 201 });
  };
  try {
    bootCoordinationBrowser();
    await new Promise((resolve) => setTimeout(resolve, 0));
    elements.get("coordination-filter-owner-label")!.value = "owner-a";
    elements.get("coordination-filter-status")!.value = "open";
    await elements.get("coordination-filter-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some(({ url }) => url.includes("/coordination/requests?") && url.includes("owner_label=owner-a") && url.includes("status=open"))).toBe(true);
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(firstPayload).toMatchObject({ actor_label: "reporter", base_revision: 7, kind: "request.progress", body: { request_id: "request-1", status: "done", evidence: [{ artifact_url: "https://example.com/artifact", location: "Summary!A1" }] } });
    expect(elements.get("coordination-status")!.textContent).toContain("network interrupted");
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progressCalls = calls.filter(({ url }) => url.endsWith("/coordination/proposals"));
    const secondPayload = JSON.parse(progressCalls.at(-1)?.body ?? "{}");
    expect(secondPayload).toEqual(firstPayload);
    expect(elements.get("coordination-status")!.textContent).toContain("canonical request is unchanged");
    expect(storage.values.get("0000:coordination-progress-attempt:v1:room-a")).toBe("");
  } finally {
    (globalThis as unknown as { document?: unknown }).document = previous.document;
    (globalThis as unknown as { location?: unknown }).location = previous.location;
    (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage = previous.sessionStorage;
    (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers = previous.helpers;
    globalThis.fetch = previous.fetch;
  }
});

test("executes the served client asset through the progress form and review endpoint", async () => {
  const source = await browserAsset("client.js")?.text();
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = false;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    querySelector<T extends Element>(): T | null { return null; }
    querySelectorAll(): Element[] { return []; }
    setAttribute() {}
    select() {}
    showModal() {}
    close() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = ["coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-progress-form", "coordination-progress-actor", "coordination-progress-request", "coordination-progress-status", "coordination-progress-blockers", "coordination-progress-artifact", "coordination-progress-location", "coordination-progress-verification", "coordination-progress-evidence-blockers", "coordination-progress-unverified", "coordination-progress-reopen-reason", "coordination-progress-sources", "coordination-progress-submit", "coordination-proposal-form", "coordination-owner-form", "coordination-owner-url", "coordination-proposal-submit", "coordination-owner-save", "coordination-actor", "coordination-title", "coordination-purpose", "coordination-owner", "coordination-requested-output", "coordination-unknowns", "coordination-completion-criteria", "coordination-decision-impact", "coordination-sources"];
  const elements = new Map(names.map((name) => [name, new Element()]));
  const storage = memoryStorage();
  let roomReads = 0;
  const documentObject = {
    body: { dataset: { get room() { roomReads += 1; return roomReads === 1 ? undefined : "room-a"; } } },
    documentElement: { dataset: {} as Record<string, string> },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(["addEventListener", "document", "fetch", "location", "localStorage", "matchMedia", "navigator", "sessionStorage"].map((key) => [key, globals[key]]));
  const calls: { url: string; body?: string }[] = [];
  globals.document = documentObject;
  globals.location = { origin: "https://msg.0000.chat", pathname: "/room-a", href: "https://msg.0000.chat/room-a", protocol: "https:" };
  globals.navigator = { onLine: true };
  globals.matchMedia = () => ({ matches: false, addEventListener() {} });
  globals.localStorage = { getItem: () => null, setItem: () => {} };
  globals.sessionStorage = storage;
  globals.addEventListener = () => {};
  globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify({ pending_proposal_count: 1, pending_proposals: [{ proposal_id: "progress-review", revision: 1, kind: "request.progress", title: "Progress report: done", status: "pending", detail_url: "/coordination/proposals/progress-review" }], published_request_count: 1, published_requests: [{ request_id: "request-1", title: "Published request", status: "open" }], published_revision: 2, proposals_url: "/coordination/proposals", requests_url: "/coordination/requests" }), { status: 200 });
    if (url.includes("/coordination/proposals/progress-review/revisions/1")) return new Response(JSON.stringify({ proposal: { proposal_id: "progress-review", revision: 1, base_revision: 2, kind: "request.progress", status: "pending", body: { blockers: [], evidence: [{ artifact_url: "https://example.com/review", location: "Summary!A1", reported_verification: "Reported checked", remaining_blockers: [] }], request_id: "request-1", status: "done" }, source_messages: [{ id: "message-2", display_name: "Source", citation_url: "/messages/message-2" }] } }), { status: 200 });
    if (url.endsWith("/coordination/proposals")) return new Response(JSON.stringify({ proposal: { proposal_id: "progress-1", revision: 1 } }), { status: 201 });
    return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
  };
  try {
    new Function(source ?? "")();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reviewButton = elements.get("coordination-overview")!.children.flatMap((child) => child.children).find((child) => child.textContent === "Review exact revision");
    reviewButton?.onclick?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(elements.get("coordination-review")!.children.some((child) => child.textContent?.includes("https://example.com/review"))).toBe(true);
    expect(elements.get("coordination-review")!.children.some((child) => child.href === "/messages/message-2")).toBe(true);
    elements.get("coordination-progress-actor")!.value = "served reporter";
    elements.get("coordination-progress-request")!.value = "request-1";
    elements.get("coordination-progress-status")!.value = "done";
    elements.get("coordination-progress-artifact")!.value = "https://example.com/served-artifact";
    elements.get("coordination-progress-verification")!.value = "Reported checked in the served flow.";
    elements.get("coordination-progress-sources")!.value = "message-2";
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progressCall = calls.find((call) => call.url.endsWith("/coordination/proposals"));
    expect(roomReads).toBeGreaterThan(1);
    expect(progressCall?.body && JSON.parse(progressCall.body)).toMatchObject({ kind: "request.progress", actor_label: "served reporter", body: { request_id: "request-1", status: "done", evidence: [{ artifact_url: "https://example.com/served-artifact" }] } });
    expect(elements.get("coordination-status")!.textContent).toContain("canonical request is unchanged");
  } finally {
    Object.assign(globals, saved);
  }
});

test("restores a frozen progress revision target across an ambiguous reload", async () => {
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = false;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = ["coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-progress-form", "coordination-progress-actor", "coordination-progress-request", "coordination-progress-status", "coordination-progress-blockers", "coordination-progress-artifact", "coordination-progress-location", "coordination-progress-verification", "coordination-progress-evidence-blockers", "coordination-progress-unverified", "coordination-progress-reopen-reason", "coordination-progress-sources", "coordination-progress-submit"];
  const elements = new Map(names.map((name) => [name, new Element()]));
  const frozenPayload = { actor_label: "reporter", base_revision: 4, body: { blockers: ["Waiting"], evidence: [], request_id: "request-1", status: "blocked" }, client_retry_id: "revision-retry", kind: "request.progress", source_message_ids: ["message-1"] };
  const storage = memoryStorage({ "0000:coordination-progress-attempt:v1:room-a": JSON.stringify({ client_retry_id: "revision-retry", payload: frozenPayload, revision_proposal_id: "proposal-progress", revision_kind: "request.progress" }) });
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const previous = { document: (globalThis as unknown as { document?: unknown }).document, location: (globalThis as unknown as { location?: unknown }).location, sessionStorage: (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage, helpers: (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers, fetch: globalThis.fetch };
  const calls: string[] = [];
  let revisionAttempt = 0;
  (globalThis as unknown as { document: unknown }).document = documentObject;
  (globalThis as unknown as { location: unknown }).location = { origin: "https://msg.0000.chat" };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  (globalThis as unknown as { __msgCoordinationHelpers: ReturnType<typeof createCoordinationBrowserHelpers> }).__msgCoordinationHelpers = createCoordinationBrowserHelpers();
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes("/proposals/proposal-progress/revisions")) {
      revisionAttempt += 1;
      if (revisionAttempt === 1) throw new Error("ambiguous network result");
      return new Response(JSON.stringify({ proposal: { proposal_id: "proposal-progress", revision: 2 } }), { status: 201 });
    }
    return new Response(JSON.stringify({ pending_proposal_count: 1, pending_proposals: [], published_request_count: 1, published_requests: [{ request_id: "request-1", title: "Request", status: "blocked" }], published_revision: 4 }), { status: 200 });
  };
  try {
    bootCoordinationBrowser();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    bootCoordinationBrowser();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.filter((url) => url.includes("/proposals/proposal-progress/revisions"))).toHaveLength(2);
    expect(calls.filter((url) => url.includes("/coordination/proposals") && !url.includes("/revisions"))).toHaveLength(0);
  } finally {
    (globalThis as unknown as { document?: unknown }).document = previous.document;
    (globalThis as unknown as { location?: unknown }).location = previous.location;
    (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage = previous.sessionStorage;
    (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers = previous.helpers;
    globalThis.fetch = previous.fetch;
  }
});

test("keeps a definite 413 retry frozen until an explicit edited progress submission", async () => {
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = true;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = ["coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-progress-form", "coordination-progress-actor", "coordination-progress-request", "coordination-progress-status", "coordination-progress-blockers", "coordination-progress-artifact", "coordination-progress-location", "coordination-progress-verification", "coordination-progress-evidence-blockers", "coordination-progress-unverified", "coordination-progress-reopen-reason", "coordination-progress-sources", "coordination-progress-submit", "coordination-progress-new"];
  const elements = new Map(names.map((name) => [name, new Element()]));
  elements.get("coordination-progress-actor")!.value = "reporter";
  elements.get("coordination-progress-request")!.value = "request-1";
  elements.get("coordination-progress-status")!.value = "in_progress";
  elements.get("coordination-progress-sources")!.value = "message-1";
  const storage = memoryStorage();
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const previous = { document: (globalThis as unknown as { document?: unknown }).document, location: (globalThis as unknown as { location?: unknown }).location, sessionStorage: (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage, helpers: (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers, fetch: globalThis.fetch };
  const calls: { url: string; body?: string }[] = [];
  let progressCall = 0;
  (globalThis as unknown as { document: unknown }).document = documentObject;
  (globalThis as unknown as { location: unknown }).location = { origin: "https://msg.0000.chat" };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  (globalThis as unknown as { __msgCoordinationHelpers: ReturnType<typeof createCoordinationBrowserHelpers> }).__msgCoordinationHelpers = createCoordinationBrowserHelpers();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify({ pending_proposal_count: 0, pending_proposals: [], published_request_count: 1, published_requests: [{ request_id: "request-1", title: "Request", status: "open" }], published_revision: 1 }), { status: 200 });
    progressCall += 1;
    if (progressCall < 3) return new Response(JSON.stringify({ error: { message: "The coordination payload is too large." } }), { status: 413 });
    return new Response(JSON.stringify({ proposal: { proposal_id: "progress-new", revision: 1 } }), { status: 201 });
  };
  try {
    bootCoordinationBrowser();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(elements.get("coordination-progress-new")!.hidden).toBe(false);
    expect(elements.get("coordination-status")!.textContent).toContain("payload is too large");
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retryPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(retryPayload).toEqual(firstPayload);
    elements.get("coordination-progress-status")!.value = "blocked";
    elements.get("coordination-progress-new")!.listeners.get("click")?.({ preventDefault() {} });
    await elements.get("coordination-progress-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const editedPayload = JSON.parse(calls.filter(({ url }) => url.endsWith("/coordination/proposals")).at(-1)?.body ?? "{}");
    expect(editedPayload).toMatchObject({ kind: "request.progress", body: { status: "blocked" } });
    expect(editedPayload.client_retry_id).not.toBe(firstPayload.client_retry_id);
    expect(storage.values.get("0000:coordination-progress-attempt:v1:room-a")).toBe("");
  } finally {
    (globalThis as unknown as { document?: unknown }).document = previous.document;
    (globalThis as unknown as { location?: unknown }).location = previous.location;
    (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage = previous.sessionStorage;
    (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers = previous.helpers;
    globalThis.fetch = previous.fetch;
  }
});

test("keeps the same frozen proposal retry across network and malformed-receipt failures", async () => {
  class Element {
    value = "";
    textContent: string | null = "";
    disabled = false;
    hidden = false;
    className = "";
    dataset: Record<string, string> = {};
    href = "";
    target = "";
    rel = "";
    type = "";
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    children: Element[] = [];
    onclick: (() => void) | null = null;
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = ["coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-actor", "coordination-title", "coordination-purpose", "coordination-owner", "coordination-requested-output", "coordination-unknowns", "coordination-completion-criteria", "coordination-decision-impact", "coordination-sources", "coordination-proposal-form", "coordination-owner-form", "coordination-owner-url", "coordination-proposal-submit", "coordination-owner-save"];
  const elements = new Map(names.map((name) => [name, new Element()]));
  elements.get("coordination-actor")!.value = "participant";
  elements.get("coordination-title")!.value = "Collect evidence";
  elements.get("coordination-purpose")!.value = "Review the source";
  elements.get("coordination-owner")!.value = "owner";
  elements.get("coordination-requested-output")!.value = "Report";
  elements.get("coordination-completion-criteria")!.value = "A report exists";
  elements.get("coordination-sources")!.value = "message-1";
  const storage = memoryStorage();
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
  const previous = { document: (globalThis as unknown as { document?: unknown }).document, location: (globalThis as unknown as { location?: unknown }).location, sessionStorage: (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage, helpers: (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers, fetch: globalThis.fetch };
  const calls: { url: string; body?: string }[] = [];
  let proposalCall = 0;
  (globalThis as unknown as { document: unknown }).document = documentObject;
  (globalThis as unknown as { location: unknown }).location = { origin: "https://msg.0000.chat" };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  (globalThis as unknown as { __msgCoordinationHelpers: ReturnType<typeof createCoordinationBrowserHelpers> }).__msgCoordinationHelpers = createCoordinationBrowserHelpers();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify({ pending_proposal_count: 0, pending_proposals: [], published_request_count: 0, published_requests: [], published_revision: 0, proposals_url: "/coordination/proposals", requests_url: "/coordination/requests" }), { status: 200 });
    proposalCall += 1;
    if (proposalCall === 1) throw new Error("network interrupted");
    return new Response("{}", { status: 201 });
  };
  try {
    bootCoordinationBrowser();
    await Promise.resolve();
    await elements.get("coordination-proposal-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(elements.get("coordination-status")!.textContent).toContain("network interrupted");
    await elements.get("coordination-proposal-form")!.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPayload = JSON.parse(calls.at(-1)?.body ?? "{}");
    expect(secondPayload).toEqual(firstPayload);
    expect(elements.get("coordination-status")!.textContent).toContain("receipt was incomplete");
    expect(storage.values.get("0000:coordination-proposal-attempt:v1:room-a")).toContain(firstPayload.client_retry_id);
  } finally {
    (globalThis as unknown as { document?: unknown }).document = previous.document;
    (globalThis as unknown as { location?: unknown }).location = previous.location;
    (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage = previous.sessionStorage;
    (globalThis as unknown as { __msgCoordinationHelpers?: unknown }).__msgCoordinationHelpers = previous.helpers;
    globalThis.fetch = previous.fetch;
  }
});

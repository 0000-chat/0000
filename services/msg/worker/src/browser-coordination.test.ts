import { expect, test } from "bun:test";

import { browserAsset, renderBrowserPage } from "./browser";
import { bootCoordinationBrowser, createCoordinationBrowserHelpers, normalizeCoordinationManagementUrl, readCoordinationManagementUrl, retainCoordinationManagementUrl } from "./browser-coordination";
import { parseCoordinationDispute, parseCoordinationDisputeReview, parseCoordinationProposal } from "./coordination-domain";

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
  expect(html).toContain('id="coordination-decision-proposal-form"');
  expect(html).toContain('id="coordination-position-form"');
  expect(html).toContain('id="coordination-decision-approval-form"');
  expect(html).toContain('id="coordination-decision-approval-message-form"');
  expect(html).toContain("Record owner-attested acceptance");
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
    documentElement: { dataset: {} as Record<string, string> },
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
    documentElement: { dataset: {} as Record<string, string> },
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

test("executes the served labelled decision flow with frozen retries, positions, owner evidence, and explicit ordinary messaging", async () => {
  const source = await browserAsset("client.js")?.text();
  class Element {
    value = "";
    checked = false;
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
    "coordination-panel", "coordination-overview", "coordination-review", "coordination-status", "coordination-refresh", "coordination-filter-form", "coordination-filter-owner-label", "coordination-filter-status",
    "coordination-owner-form", "coordination-owner-url", "coordination-owner-save", "coordination-owner",
    "coordination-proposal-form", "coordination-progress-form", "coordination-proposal-submit", "coordination-progress-submit",
    "coordination-decision-proposal-form", "coordination-decision-actor", "coordination-decision-title", "coordination-decision-text", "coordination-decision-required-labels", "coordination-decision-sources", "coordination-decision-proposal-submit", "coordination-decision-proposal-new",
    "coordination-position-form", "coordination-position-reporter", "coordination-position-decision-id", "coordination-position-revision", "coordination-position-participant", "coordination-position-statement", "coordination-position-sources", "coordination-position-submit", "coordination-position-new",
    "coordination-decision-approval-form", "coordination-decision-approval-owner-label", "coordination-decision-approval-attestation", "coordination-decision-approval-labels", "coordination-decision-approval-inspect", "coordination-decision-approval-evidence-review", "coordination-decision-approval-submit", "coordination-decision-approval-new",
    "coordination-decision-approval-message-form", "coordination-decision-approval-message-author", "coordination-decision-approval-message-content", "coordination-decision-approval-message-submit", "coordination-decision-approval-message-new",
  ];
  const elements = new Map(names.map((name) => [name, new Element()]));
  elements.get("coordination-decision-actor")!.value = "participant";
  elements.get("coordination-decision-title")!.value = "Choose deployment target";
  elements.get("coordination-decision-text")!.value = "Deploy the reviewed target after exact evidence is checked.";
  elements.get("coordination-decision-required-labels")!.value = "alice\nbob";
  elements.get("coordination-decision-sources")!.value = "proposal-source";
  elements.get("coordination-position-reporter")!.value = "reporter";
  elements.get("coordination-position-participant")!.value = "alice";
  elements.get("coordination-position-statement")!.value = "Alice reports that the target is ready.";
  elements.get("coordination-position-sources")!.value = "position-source";
  elements.get("coordination-decision-approval-message-author")!.value = "owner";
  elements.get("coordination-decision-approval-message-content")!.value = "Explicit approval note after review.";
  const storage = memoryStorage({ "0000:coordination-management-url:v1:room-a": "https://msg.0000.chat/manage/room-a/owner-token" });
  const proposal = { actor_label: "participant", base_revision: 0, body: { proposal_text: "Deploy the reviewed target after exact evidence is checked.", required_approver_labels: ["alice", "bob"], title: "Choose deployment target" }, kind: "decision.proposal", proposal_id: "decision-1", revision: 1, source_messages: [{ id: "proposal-source", author: "participant", display_name: "Participant", citation_url: "/messages/proposal-source" }], status: "pending" };
  const publishedProposal = { ...proposal, status: "published" };
  const calls: { url: string; body?: string; idempotencyKey?: string }[] = [];
  let proposalAttempts = 0;
  let publicationAttempts = 0;
  let accepted = false;
  let ordinaryMessages = 0;
  let ordinaryAttempts = 0;
  const overviewPayload = () => ({
    accepted_decision_count: accepted ? 1 : 0,
    coordination_cursor: accepted ? 4 : publicationAttempts > 0 ? 2 : 1,
    decision_count: publicationAttempts > 0 ? 1 : 0,
    decision_summaries: publicationAttempts > 0 ? [{ accepted_record_id: accepted ? "accepted-1" : undefined, decision_id: "decision-1", detail_url: "/room-a/coordination/decisions/decision-1", latest_proposal_revision: 1, proposal_text: proposal.body.proposal_text, published_revision: accepted ? 2 : 1, required_approver_labels: ["alice", "bob"], state: accepted ? "accepted" : "recommended", title: proposal.body.title }] : [],
    decisions_url: "/room-a/coordination/decisions?limit=20",
    empty: false,
    pending_proposal_count: accepted ? 0 : 1,
    pending_proposals: accepted ? [] : [{ proposal_id: "decision-1", revision: 1, kind: "decision.proposal", title: proposal.body.title, status: "pending", detail_url: "/room-a/coordination/proposals/decision-1" }],
    published_request_count: 0,
    published_requests: [],
    published_revision: accepted ? 2 : publicationAttempts > 0 ? 1 : 0,
    proposals_url: "/room-a/coordination/proposals",
    request_status_counts: { open: 0, in_progress: 0, blocked: 0, done: 0, withdrawn: 0 },
    requests_url: "/room-a/coordination/requests?limit=20",
  });
  const decisionDetail = () => ({
    coordination_cursor: accepted ? 4 : 2,
    decision: { accepted_record_id: accepted ? "accepted-1" : undefined, decision_id: "decision-1", detail_url: "/room-a/coordination/decisions/decision-1", latest_proposal_revision: 1, proposal_text: proposal.body.proposal_text, published_revision: accepted ? 2 : 1, required_approver_labels: ["alice", "bob"], state: accepted ? "accepted" : "recommended", title: proposal.body.title },
    history: [{ body: proposal.body, kind: "decision.proposal", proposal: publishedProposal, proposal_id: "decision-1", proposal_revision: 1 }],
    latest_message: 2,
    positions: [{ decision_proposal_id: "decision-1", decision_revision: 1, participant_label: "alice", position_id: "position-1", source_messages: [{ id: "position-source", citation_url: "/messages/position-source" }], statement: "Alice reports that the target is ready." }],
    published_revision: accepted ? 2 : 1,
  });
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
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
  globals.document = documentObject;
  globals.location = { origin: "https://msg.0000.chat", pathname: "/room-a", href: "https://msg.0000.chat/room-a", protocol: "https:" };
  globals.navigator = { onLine: true };
  globals.matchMedia = () => ({ matches: false, addEventListener() {} });
  globals.localStorage = { getItem: () => null, setItem: () => {} };
  globals.sessionStorage = storage;
  globals.addEventListener = () => {};
  globals.WebSocket = TestSocket;
  globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body, idempotencyKey: new Headers(init?.headers).get("idempotency-key") ?? undefined });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify(overviewPayload()), { status: 200 });
    if (url.includes("/coordination/proposals/decision-1/revisions/1")) return new Response(JSON.stringify({ proposal }), { status: 200 });
    if (url.includes("/coordination/decisions/decision-1/records/accepted-1")) return new Response(JSON.stringify({ accepted_record: { accepted_record_id: "accepted-1", decision_revision: 1, owner_attestation: true, owner_label: "owner" }, approvals: [{ accepted_record_id: "accepted-1", approval_record_id: "approval-alice", citation_url: "/messages/alice-source", participant_label: "alice", source_author: "alice", source_message_id: "alice-source" }, { accepted_record_id: "accepted-1", approval_record_id: "approval-bob", citation_url: "/messages/bob-source", participant_label: "bob", source_author: "bob", source_message_id: "bob-source" }] }), { status: 200 });
    if (url.includes("/coordination/decisions/decision-1?")) return new Response(JSON.stringify(decisionDetail()), { status: 200 });
    if (url.endsWith("/coordination/proposals")) {
      const parsed = JSON.parse(body ?? "{}");
      if (parsed.kind === "decision.proposal") {
        proposalAttempts += 1;
        if (proposalAttempts === 1) throw new Error("decision proposal network interrupted");
        return new Response(JSON.stringify({ proposal: { proposal_id: "decision-1", revision: 1 } }), { status: 201 });
      }
      if (parsed.kind === "decision.position") return new Response(JSON.stringify({ position: { position_id: "position-1" }, proposal: { proposal_id: "position-1", revision: 1 } }), { status: 201 });
    }
    if (url.includes("/manage/room-a/owner-token/coordination/publish")) {
      const parsed = JSON.parse(body ?? "{}");
      if (parsed.operation !== undefined) return new Response(JSON.stringify({ error: { message: "unknown operation field" } }), { status: 400 });
      publicationAttempts += 1;
      if (parsed.decision_publication?.mode === "acceptance") { accepted = true; return new Response(JSON.stringify({ accepted_record: { accepted_record_id: "accepted-1" }, decision: { decision_id: "decision-1", state: "accepted" }, proposal: publishedProposal }), { status: 201 }); }
      return new Response(JSON.stringify({ decision: { decision_id: "decision-1", state: "recommended" }, proposal: publishedProposal }), { status: 201 });
    }
    if (url.includes("/room-a/messages/")) return new Response(JSON.stringify({ message: { author: url.includes("alice-source") ? "alice" : "bob", content: url.includes("alice-source") ? "Alice exact approval text." : "Bob exact approval text.", display_name: url.includes("alice-source") ? "Alice" : "Bob", id: url.split("/").at(-1), sequence: 3 } }), { status: 200 });
    if (url === "/room-a" && init?.method === "POST") { ordinaryAttempts += 1; if (ordinaryAttempts === 1) throw new Error("ordinary approval response lost"); if (ordinaryAttempts === 3) return new Response(JSON.stringify({ error: { message: "ordinary message rejected" } }), { status: 400 }); ordinaryMessages += 1; return new Response(JSON.stringify({ message: { id: `ordinary-approval-message-${ordinaryMessages}` } }), { status: 201 }); }
    if (url === "/room-a") return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
    return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
  };
  try {
    new Function(source ?? "")();
    await tick();
    await elements.get("coordination-decision-proposal-form")!.submit();
    await tick();
    const firstProposalPayload = JSON.parse(calls.filter(({ url, body }) => url.endsWith("/coordination/proposals") && JSON.parse(body ?? "{}").kind === "decision.proposal").at(-1)?.body ?? "{}");
    expect(elements.get("coordination-status")!.textContent).toContain("network interrupted");
    await elements.get("coordination-decision-proposal-form")!.submit();
    await tick();
    const decisionProposalCalls = calls.filter(({ url, body }) => url.endsWith("/coordination/proposals") && JSON.parse(body ?? "{}").kind === "decision.proposal");
    expect(decisionProposalCalls).toHaveLength(2);
    expect(JSON.parse(decisionProposalCalls[1]!.body ?? "{}")).toEqual(firstProposalPayload);
    const reviewButton = elements.get("coordination-overview")!.children.flatMap((child) => child.children).find((child) => child.textContent === "Review exact revision");
    reviewButton?.onclick?.();
    await tick();
    elements.get("coordination-review")!.children.find((child) => child.textContent === "Publish labelled recommendation")?.onclick?.();
    await tick(); await tick();
    expect(calls.some(({ url, body }) => url.includes("/coordination/publish") && JSON.parse(body ?? "{}").decision_publication?.mode === "recommendation")).toBe(true);
    elements.get("coordination-position-decision-id")!.value = "decision-1";
    elements.get("coordination-position-revision")!.value = "1";
    await elements.get("coordination-position-form")!.submit();
    await tick();
    expect(calls.some(({ url, body }) => url.endsWith("/coordination/proposals") && JSON.parse(body ?? "{}").kind === "decision.position")).toBe(true);
    elements.get("coordination-decision-approval-owner-label")!.value = "owner";
    elements.get("coordination-decision-approval-attestation")!.checked = true;
    elements.get("coordination-decision-approval-labels")!.value = "alice | alice-source\nbob | bob-source";
    elements.get("coordination-decision-approval-inspect")!.listeners.get("click")?.({ preventDefault() {} });
    await tick();
    expect(elements.get("coordination-decision-approval-evidence-review")!.children.some((child) => child.textContent?.includes("Alice exact approval text."))).toBe(true);
    await elements.get("coordination-decision-approval-form")!.submit();
    await tick(); await tick();
    const acceptance = calls.find(({ url, body }) => url.includes("/coordination/publish") && JSON.parse(body ?? "{}").decision_publication?.mode === "acceptance");
    expect(acceptance?.body && JSON.parse(acceptance.body)).toMatchObject({ decision_publication: { mode: "acceptance", owner_attestation: true, approvals: [{ participant_label: "alice", source_message_id: "alice-source" }, { participant_label: "bob", source_message_id: "bob-source" }] }, owner_label: "owner", proposal_id: "decision-1", revision: 1 });
    expect(acceptance?.body && JSON.parse(acceptance.body)).not.toHaveProperty("operation");
    expect(ordinaryMessages).toBe(0);
    await elements.get("coordination-decision-approval-message-form")!.submit();
    await tick();
    await elements.get("coordination-decision-approval-message-form")!.submit();
    await tick();
    expect(ordinaryMessages).toBe(1);
    const ordinaryAttemptsForMessage = calls.filter(({ url }) => url === "/room-a");
    expect(ordinaryAttemptsForMessage).toHaveLength(3);
    expect(ordinaryAttemptsForMessage[1]?.body).toBe(ordinaryAttemptsForMessage[2]?.body);
    expect(ordinaryAttemptsForMessage[1]?.idempotencyKey).toBe(ordinaryAttemptsForMessage[2]?.idempotencyKey);
    expect(JSON.parse(ordinaryAttemptsForMessage[2]?.body ?? "{}")).toMatchObject({ author: "owner", content: "Explicit approval note after review.", semantic_type: "decision" });
    elements.get("coordination-decision-approval-message-content")!.value = "Rejected then edited.";
    await elements.get("coordination-decision-approval-message-form")!.submit();
    await tick();
    expect(elements.get("coordination-decision-approval-message-new")!.hidden).toBe(false);
    elements.get("coordination-decision-approval-message-content")!.value = "Edited ordinary approval message.";
    elements.get("coordination-decision-approval-message-new")!.listeners.get("click")?.({ preventDefault() {} });
    await elements.get("coordination-decision-approval-message-form")!.submit();
    await tick();
    expect(ordinaryMessages).toBe(2);
    expect(elements.get("coordination-review")!.children.some((child) => child.textContent?.includes("Immutable accepted record"))).toBe(true);
  } finally {
    for (const socket of TestSocket.instances) socket.close();
    Object.assign(globals, saved);
  }
});

test("served correction, withdrawal, owner review, and supersession controls preserve exact targets and attribution", async () => {
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
    checked = false;
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = [
    "coordination-panel", "coordination-overview", "coordination-pinned-panel", "coordination-review", "coordination-status", "coordination-refresh", "coordination-filter-form", "coordination-filter-owner-label", "coordination-filter-status",
    "coordination-owner-form", "coordination-owner-url", "coordination-owner-save",
    "coordination-correction-form", "coordination-correction-actor", "coordination-correction-target-type", "coordination-correction-message-id", "coordination-correction-publication-revision", "coordination-correction-claim-path", "coordination-correction-inspect", "coordination-correction-review", "coordination-correction-text", "coordination-correction-sources", "coordination-correction-submit", "coordination-correction-new",
    "coordination-dispute-form", "coordination-dispute-actor", "coordination-dispute-accepted-record", "coordination-dispute-kind", "coordination-dispute-approval-record", "coordination-dispute-statement", "coordination-dispute-sources", "coordination-dispute-inspect", "coordination-dispute-review", "coordination-dispute-submit", "coordination-dispute-new",
    "coordination-dispute-review-form", "coordination-dispute-review-report", "coordination-dispute-review-disposition", "coordination-dispute-review-rationale", "coordination-dispute-review-sources", "coordination-dispute-review-submit", "coordination-dispute-review-new",
    "coordination-supersession-form", "coordination-supersession-actor", "coordination-supersession-predecessor", "coordination-supersession-successor", "coordination-supersession-revision", "coordination-supersession-sources", "coordination-supersession-inspect", "coordination-supersession-review", "coordination-supersession-submit", "coordination-supersession-new",
  ];
  const elements = new Map(names.map((name) => [name, new Element()]));
  const storage = memoryStorage({ "0000:coordination-management-url:v1:room-a": "https://msg.0000.chat/manage/room-a/owner-token" });
  const calls: { url: string; body?: string }[] = [];
  let correctionAttempts = 0;
  const documentObject = {
    body: { dataset: { room: "room-a" } },
    documentElement: { dataset: {} as Record<string, string> },
    createElement: () => new Element(),
    querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
    querySelectorAll: () => [] as Element[],
  };
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
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "location", "localStorage", "matchMedia", "navigator", "sessionStorage"].map((key) => [key, globals[key]]));
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
  globals.document = documentObject;
  globals.location = { origin: "https://msg.0000.chat", pathname: "/room-a", href: "https://msg.0000.chat/room-a", protocol: "https:" };
  globals.navigator = { onLine: true };
  globals.matchMedia = () => ({ matches: false, addEventListener() {} });
  globals.localStorage = { getItem: () => null, setItem: () => {} };
  globals.sessionStorage = storage;
  globals.addEventListener = () => {};
  globals.WebSocket = TestSocket;
  globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = typeof init?.body === "string" ? init.body : undefined; calls.push({ url, body });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify({ coordination_cursor: 5, correction_count: 1, correction_summaries: [{ correction_id: "old-correction", correction_text: "Earlier account", detail_url: "/coordination/corrections/old-correction", owner_label: "owner", publication_revision: 3, reporter_label: "reporter", target: { type: "message", message_id: "message-1" } }], corrections_url: "/coordination/corrections?limit=20", decision_count: 0, empty: false, pending_proposal_count: 0, pending_proposals: [], published_request_count: 0, published_requests: [], published_revision: 5, proposals_url: "/coordination/proposals", requests_url: "/coordination/requests" }), { status: 200 });
    if (url.endsWith("/coordination/publications/4")) return new Response(JSON.stringify({ publication: { body: { claim: { title: "Original title", status: "open" } }, source_messages: [{ id: "source-publication", author: "source-author", display_name: "Source", citation_url: "/room-a/messages/source-publication" }] } }), { status: 200 });
    if (url.endsWith("/coordination/proposals")) {
      const parsed = JSON.parse(body ?? "{}");
      if (parsed.kind === "claim.correction") { parseCoordinationProposal(parsed); correctionAttempts += 1; if (correctionAttempts === 1) throw new Error("ambiguous correction result"); return new Response(JSON.stringify({ proposal: { proposal_id: "correction-1", revision: 1 } }), { status: 201 }); }
      if (parsed.kind === "decision.supersession") { parseCoordinationProposal(parsed); return new Response(JSON.stringify({ proposal: { proposal_id: "supersession-1", revision: 1 } }), { status: 201 }); }
    }
    if (url.endsWith("/coordination/disputes")) { parseCoordinationDispute(JSON.parse(body ?? "{}")); return new Response(JSON.stringify({ dispute: { report_id: "report-1" }, report: { report_id: "report-1" }, replayed: false }), { status: 201 }); }
    if (url.includes("/coordination/disputes/report-1?")) return new Response(JSON.stringify({ dispute: { accepted_record_id: "accepted-1", actor_label: "reporter", kind: "approval_withdrawal", report_id: "report-1", reviews: [], reviews_has_more: false, statement: "Reporter account" } }), { status: 200 });
    if (url.endsWith("/coordination/disputes/report-1/review")) { parseCoordinationDisputeReview(JSON.parse(body ?? "{}")); return new Response(JSON.stringify({ replayed: false, review: { report_id: "report-1", review_id: "review-1" } }), { status: 201 }); }
    if (url.includes("/messages/")) return new Response(JSON.stringify({ message: { author: "reporter", content: "Source report", display_name: "Reporter", id: url.split("/").at(-1), sequence: 1 } }), { status: 200 });
    return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
  };
  try {
    new Function(source ?? "")();
    await tick();
    elements.get("coordination-correction-actor")!.value = "reporter";
    elements.get("coordination-correction-target-type")!.value = "publication";
    elements.get("coordination-correction-publication-revision")!.value = "4";
    elements.get("coordination-correction-text")!.value = "Corrected title";
    elements.get("coordination-correction-sources")!.value = "source-publication";
    elements.get("coordination-correction-inspect")!.listeners.get("click")?.({ preventDefault() {} });
    await tick();
    expect(elements.get("coordination-correction-claim-path")!.children.some((child) => child.textContent?.includes("claim.title"))).toBe(true);
    elements.get("coordination-correction-claim-path")!.value = JSON.stringify(["claim", "title"]);
    await elements.get("coordination-correction-form")!.submit(); await tick();
    const firstCorrection = JSON.parse(calls.find(({ body }) => body?.includes('"claim.correction"'))?.body ?? "{}");
    expect(firstCorrection).toMatchObject({ kind: "claim.correction", body: { target: { type: "publication", published_revision: 4, claim_path: ["claim", "title"] } } });
    elements.get("coordination-correction-publication-revision")!.value = "5";
    await elements.get("coordination-correction-form")!.submit(); await tick();
    expect(elements.get("coordination-correction-new")!.hidden).toBe(false);
    elements.get("coordination-correction-new")!.listeners.get("click")?.({ preventDefault() {} });
    elements.get("coordination-correction-inspect")!.listeners.get("click")?.({ preventDefault() {} }); await tick();
    elements.get("coordination-correction-claim-path")!.value = JSON.stringify(["claim", "title"]);
    await elements.get("coordination-correction-form")!.submit(); await tick();
    const corrections = calls.filter(({ body }) => body?.includes('"claim.correction"'));
    expect(corrections).toHaveLength(2);
    expect(JSON.parse(corrections[1]!.body ?? "{}").body.target.published_revision).toBe(5);

    elements.get("coordination-dispute-actor")!.value = "reporter";
    elements.get("coordination-dispute-accepted-record")!.value = "accepted-1";
    elements.get("coordination-dispute-kind")!.value = "approval_withdrawal";
    elements.get("coordination-dispute-approval-record")!.value = "approval-alice";
    elements.get("coordination-dispute-statement")!.value = "Reporter disputes Alice approval.";
    elements.get("coordination-dispute-sources")!.value = "report-source";
    await elements.get("coordination-dispute-form")!.submit(); await tick();
    const report = JSON.parse(calls.find(({ url }) => url.endsWith("/coordination/disputes"))?.body ?? "{}");
    expect(report).toMatchObject({ actor_label: "reporter", accepted_record_id: "accepted-1", kind: "approval_withdrawal", approval_record_id: "approval-alice" });
    elements.get("coordination-dispute-review-report")!.value = "report-1";
    elements.get("coordination-dispute-review-rationale")!.value = "Reviewed source.";
    await elements.get("coordination-dispute-review-form")!.submit(); await tick();
    const review = calls.find(({ url }) => url.endsWith("/coordination/disputes/report-1/review"));
    expect(review?.url).toBe("https://msg.0000.chat/manage/room-a/owner-token/coordination/disputes/report-1/review");
    expect(JSON.parse(review?.body ?? "{}")).toMatchObject({ owner_label: "Room owner", disposition: "acknowledged" });
    expect(JSON.parse(review?.body ?? "{}")).not.toHaveProperty("report_id");

    elements.get("coordination-supersession-actor")!.value = "reporter";
    elements.get("coordination-supersession-predecessor")!.value = "accepted-1";
    elements.get("coordination-supersession-successor")!.value = "decision-2";
    elements.get("coordination-supersession-revision")!.value = "2";
    await elements.get("coordination-supersession-form")!.submit(); await tick();
    const supersession = JSON.parse(calls.find(({ body }) => body?.includes('"decision.supersession"'))?.body ?? "{}");
    expect(supersession).toMatchObject({ kind: "decision.supersession", body: { predecessor_accepted_record_id: "accepted-1", successor_decision_id: "decision-2", successor_decision_revision: 2 } });
  } finally {
    for (const socket of TestSocket.instances) socket.close();
    Object.assign(globals, saved);
  }
});

test("served structured attempts restore exact correction and owner-review payloads across fresh runtimes", async () => {
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
    checked = false;
    children: Element[] = [];
    onclick: (() => void) | null = null;
    listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) { this.listeners.set(type, listener); }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Element[]) { this.children = [...nodes]; }
    select() {}
    async submit() { await this.listeners.get("submit")?.({ preventDefault() {} }); }
  }
  const names = [
    "coordination-panel", "coordination-overview", "coordination-pinned-panel", "coordination-review", "coordination-status", "coordination-refresh", "coordination-filter-form", "coordination-filter-owner-label", "coordination-filter-status",
    "coordination-owner-form", "coordination-owner-url", "coordination-owner-save", "coordination-owner",
    "coordination-correction-form", "coordination-correction-actor", "coordination-correction-target-type", "coordination-correction-message-id", "coordination-correction-publication-revision", "coordination-correction-claim-path", "coordination-correction-inspect", "coordination-correction-review", "coordination-correction-text", "coordination-correction-sources", "coordination-correction-submit", "coordination-correction-new",
    "coordination-dispute-form", "coordination-dispute-actor", "coordination-dispute-accepted-record", "coordination-dispute-kind", "coordination-dispute-approval-record", "coordination-dispute-statement", "coordination-dispute-sources", "coordination-dispute-inspect", "coordination-dispute-submit", "coordination-dispute-new",
    "coordination-dispute-review-form", "coordination-dispute-review-report", "coordination-dispute-review-disposition", "coordination-dispute-review-rationale", "coordination-dispute-review-sources", "coordination-dispute-review-submit", "coordination-dispute-review-new",
    "coordination-supersession-form", "coordination-supersession-actor", "coordination-supersession-predecessor", "coordination-supersession-successor", "coordination-supersession-revision", "coordination-supersession-sources", "coordination-supersession-inspect", "coordination-supersession-review", "coordination-supersession-submit", "coordination-supersession-new",
  ];
  const storage = memoryStorage({ "0000:coordination-management-url:v1:room-a": "https://msg.0000.chat/manage/room-a/owner-token" });
  const calls: Array<{ url: string; body?: string }> = [];
  let correctionAttempts = 0;
  let reviewAttempts = 0;
  let staleReviewAttempts = 0;
  let currentRevision = 4;
  const overviewPayload = () => ({ coordination_cursor: currentRevision, correction_count: 0, correction_summaries: [], corrections_url: "/room-a/coordination/corrections?limit=20", decision_count: 0, empty: false, pending_proposal_count: 1, pending_proposals: [{ detail_url: "/room-a/coordination/proposals/request-1", kind: "request.create", proposal_id: "request-1", revision: 1, status: "pending", title: "Unrelated request" }], published_request_count: 0, published_requests: [], published_revision: currentRevision, proposals_url: "/room-a/coordination/proposals?limit=20", requests_url: "/room-a/coordination/requests?limit=20" });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = typeof init?.body === "string" ? init.body : undefined; calls.push({ url, body });
    if (url.endsWith("/coordination")) return new Response(JSON.stringify(overviewPayload()), { status: 200 });
    if (url.endsWith("/coordination/proposals/request-1/revisions/1")) return new Response(JSON.stringify({ proposal: { actor_label: "requester", base_revision: 0, body: { completion_criteria: [], decision_impact: "none", owner_label: "owner", purpose: "purpose", requested_output: "output", title: "Unrelated request", unknowns: [] }, kind: "request.create", proposal_id: "request-1", revision: 1, source_messages: [], status: "pending" } }), { status: 200 });
    if (url.endsWith("/coordination/proposals")) {
      const parsed = JSON.parse(body ?? "{}"); parseCoordinationProposal(parsed);
      if (parsed.kind === "claim.correction") {
        correctionAttempts += 1;
        if (correctionAttempts === 1) throw new Error("ambiguous correction result");
        return new Response(JSON.stringify({ replayed: false, proposal: { kind: "claim.correction", proposal_id: `correction-${correctionAttempts}`, revision: 1 } }), { status: 201 });
      }
    }
    if (url.endsWith("/coordination/disputes/report-reload/review")) {
      parseCoordinationDisputeReview(JSON.parse(body ?? "{}")); reviewAttempts += 1;
      if (reviewAttempts === 1) throw new Error("ambiguous owner review result");
      return new Response(JSON.stringify({ replayed: false, review: { report_id: "report-reload", review_id: "review-reload" } }), { status: 201 });
    }
    if (url.endsWith("/coordination/disputes/report-stale/review")) {
      parseCoordinationDisputeReview(JSON.parse(body ?? "{}")); staleReviewAttempts += 1;
      if (staleReviewAttempts === 1) return new Response(JSON.stringify({ error: { code: "stale_revision", current_revision: 5, message: "stale base" } }), { status: 409 });
      return new Response(JSON.stringify({ replayed: false, review: { report_id: "report-stale", review_id: "review-stale" } }), { status: 201 });
    }
    return new Response(JSON.stringify({ latest_message: 0, messages: [], expires_at: null }), { status: 200 });
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(["WebSocket", "addEventListener", "document", "fetch", "location", "localStorage", "matchMedia", "navigator", "sessionStorage"].map((key) => [key, globals[key]]));
  const sockets: Array<{ close(): void }> = [];
  const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); };
  const boot = () => {
    const elements = new Map(names.map((name) => [name, new Element()]));
    const documentObject = {
      body: { dataset: { room: "room-a" } },
      documentElement: { dataset: {} as Record<string, string> },
      createElement: () => new Element(),
      querySelector<T extends Element>(selector: string) { return elements.get(selector.slice(1)) as T | undefined ?? null; },
      querySelectorAll: () => [] as Element[],
    };
    class TestSocket {
      readyState = 1;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onopen: (() => void) | null = null;
      constructor() { sockets.push(this); }
      close() { this.readyState = 3; this.onclose = null; this.onerror = null; this.onopen = null; }
    }
    globals.document = documentObject; globals.location = { origin: "https://msg.0000.chat", pathname: "/room-a", href: "https://msg.0000.chat/room-a", protocol: "https:" }; globals.navigator = { onLine: true }; globals.matchMedia = () => ({ matches: false, addEventListener() {} }); globals.localStorage = { getItem: () => null, setItem: () => {} }; globals.sessionStorage = storage; globals.addEventListener = () => {}; globals.WebSocket = TestSocket; globals.fetch = fetchImpl;
    new Function(source ?? "")();
    return elements;
  };
  try {
    let elements = boot(); await tick();
    elements.get("coordination-correction-actor")!.value = "reporter";
    elements.get("coordination-correction-target-type")!.value = "message";
    elements.get("coordination-correction-message-id")!.value = "message-reload";
    elements.get("coordination-correction-text")!.value = "Corrected after reload.";
    elements.get("coordination-correction-sources")!.value = "source-reload";
    await elements.get("coordination-correction-form")!.submit(); await tick();
    const firstCorrection = calls.find(({ body }) => body?.includes('"claim.correction"'))!;
    expect(firstCorrection?.url).toBe("/room-a/coordination/proposals");
    const firstCorrectionPayload = JSON.parse(firstCorrection.body ?? "{}");
    const firstRetryId = firstCorrectionPayload.client_retry_id;
    sockets.splice(0).forEach((socket) => socket.close());

    elements = boot(); await tick();
    expect(elements.get("coordination-correction-message-id")!.value).toBe("message-reload");
    expect(elements.get("coordination-correction-text")!.value).toBe("Corrected after reload.");
    await elements.get("coordination-correction-form")!.submit(); await tick();
    const correctionCalls = calls.filter(({ body }) => body?.includes('"claim.correction"'));
    expect(correctionCalls).toHaveLength(2);
    expect(JSON.parse(correctionCalls[1]!.body ?? "{}")).toEqual(firstCorrectionPayload);
    expect(JSON.parse(correctionCalls[1]!.body ?? "{}").client_retry_id).toBe(firstRetryId);

    const reviewButton = elements.get("coordination-overview")!.children.flatMap((child) => child.children).find((child) => child.textContent === "Review exact revision");
    reviewButton?.onclick?.(); await tick();
    elements.get("coordination-review")!.children.find((child) => child.textContent === "Edit as explicit new revision")?.onclick?.();
    elements.get("coordination-correction-target-type")!.value = "message";
    elements.get("coordination-correction-message-id")!.value = "message-cross-form";
    elements.get("coordination-correction-text")!.value = "A correction must not reuse request-1.";
    await elements.get("coordination-correction-form")!.submit(); await tick();
    const crossFormCorrection = calls.filter(({ body }) => body?.includes('"claim.correction"')).at(-1);
    expect(crossFormCorrection?.url).toBe("/room-a/coordination/proposals");

    elements.get("coordination-dispute-review-report")!.value = "report-reload";
    elements.get("coordination-dispute-review-rationale")!.value = "Owner review after reload.";
    await elements.get("coordination-dispute-review-form")!.submit(); await tick();
    const firstReview = calls.find(({ url }) => url.endsWith("/coordination/disputes/report-reload/review"));
    const firstReviewPayload = JSON.parse(firstReview?.body ?? "{}");
    sockets.splice(0).forEach((socket) => socket.close());

    elements = boot(); await tick();
    expect(elements.get("coordination-dispute-review-report")!.value).toBe("report-reload");
    expect(elements.get("coordination-dispute-review-rationale")!.value).toBe("Owner review after reload.");
    await elements.get("coordination-dispute-review-form")!.submit(); await tick();
    const reviewCalls = calls.filter(({ url }) => url.endsWith("/coordination/disputes/report-reload/review"));
    expect(reviewCalls).toHaveLength(2);
    expect(JSON.parse(reviewCalls[1]!.body ?? "{}")).toEqual(firstReviewPayload);
    expect(JSON.parse(reviewCalls[1]!.body ?? "{}")).not.toHaveProperty("report_id");

    elements.get("coordination-dispute-review-report")!.value = "report-stale";
    elements.get("coordination-dispute-review-rationale")!.value = "Rebase this owner review.";
    await elements.get("coordination-dispute-review-form")!.submit(); await tick();
    expect(elements.get("coordination-dispute-review-new")!.hidden).toBe(false);
    currentRevision = 5;
    elements.get("coordination-dispute-review-new")!.listeners.get("click")?.({ preventDefault() {} }); await tick();
    await elements.get("coordination-dispute-review-form")!.submit(); await tick();
    const staleReviewCalls = calls.filter(({ url }) => url.endsWith("/coordination/disputes/report-stale/review"));
    expect(staleReviewCalls).toHaveLength(2);
    const staleFirstPayload = JSON.parse(staleReviewCalls[0]!.body ?? "{}");
    const staleRebasedPayload = JSON.parse(staleReviewCalls[1]!.body ?? "{}");
    expect(staleRebasedPayload.base_revision).toBe(5);
    expect(staleRebasedPayload.client_retry_id).not.toBe(staleFirstPayload.client_retry_id);
    expect(staleRebasedPayload).not.toHaveProperty("report_id");
  } finally {
    sockets.splice(0).forEach((socket) => socket.close());
    Object.assign(globals, saved);
  }
});

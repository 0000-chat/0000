import { expect, test } from "bun:test";

import { browserAsset } from "./browser";
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
  expect(source).toContain("Review exact revision");
  expect(source).toContain("Source evidence");
  expect(source).toContain("Save this private owner access URL");
  expect(() => new Function(source ?? "")).not.toThrow();
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

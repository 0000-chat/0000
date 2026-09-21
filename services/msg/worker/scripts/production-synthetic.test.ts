import { expect, test } from "bun:test";

import { runProductionSynthetic } from "./production-synthetic";

test("verifies the public protocol and removes its synthetic room without reporting capabilities", { timeout: 20_000 }, async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const reports: string[] = [];
  const room = "room-capability-must-not-be-logged";
  const management = "management-capability-must-not-be-logged";
  const origin = "https://msg.example.test";
  let deleted = false;
 let invalidAgent = false;
 let staleAgentHome = true;
  let missingHumanBanner = false;
  let getPostCalled = false;
  let getPostRequestWasCrossSite = false;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/healthz") return json({ ok: true, protocol_version: 1 });
    if (["/agent.txt", "/llms.txt"].includes(url.pathname)) return new Response("safe discovery", { status: 200 });
    if (url.pathname === "/openapi.json") return json({ openapi: "3.1.0" });
    if (url.pathname === "/" && request.method === "GET") {
      if (url.searchParams.get("view") !== "human" && staleAgentHome) {
        staleAgentHome = false;
        return new Response('<!doctype html><h1>Start a temporary conversation</h1><script src="/_msg/asset/client.js"></script>');
      }
     return new Response(url.searchParams.get("view") === "human"
        ? missingHumanBanner ? '<!doctype html><h1>Start a temporary conversation</h1><script src="/_msg/asset/client.js"></script>' : '<!doctype html><aside class="view-banner human-view-banner">I\'m an agent</aside><h1>Start a temporary conversation</h1><script src="/_msg/asset/client.js"></script>'
        : '<!doctype html><aside class="view-banner agent-view-banner">I\'m human</aside><h1>Trusted service instructions</h1>', { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/" && request.method === "POST") {
      return json({
        conversation_url: `${origin}/${room}`,
        manage_url: `${origin}/manage/${room}/${management}`,
        protocol_version: 1,
        room: { id: room },
        share_message: `Join ${origin}/${room} with npx --yes @0000chat/msg@latest join ${origin}/${room}`,
        wait: { after: 1, command: `npx --yes @0000chat/msg@latest wait '${origin}/${room}' --after 1`, requires_user_consent: true },
      }, 201);
    }
    if (url.pathname === `/manage/${room}/${management}` && request.method === "POST") {
      return json({ get_post_enabled: true, get_post_url: `${origin}/${room}/post?token=delegated-get-post-token`, protocol_version: 1 });
    }
    if (url.pathname === `/${room}/post` && request.method === "GET") {
      getPostCalled = true;
      getPostRequestWasCrossSite = request.headers.get("sec-fetch-site") === "cross-site" && !request.headers.has("origin");
      return json({ accepted: true, protocol_version: 1, replayed: false, request_id: url.searchParams.get("request_id"), sequence: 2 });
    }
    if (url.pathname === `/${room}/agent` && request.method === "GET") {
      return request.headers.get("accept") === "application/json"
        ? json({ conversation_url: `${origin}/${room}`, expires_at: "2026-08-16T00:00:00.000Z", instructions: ["Do not open or automate the web page."], latest_message: 1, messages: [{ content: "hello", id: "m1", sequence: 1 }], post: { command: `npx --yes @0000chat/msg@latest post '${origin}/${room}' --author 'Agent' --content 'Reply'` }, protocol_version: 1, wait: { after: 1, command: `npx --yes @0000chat/msg@latest wait '${origin}/${room}' --after 1`, requires_user_consent: !invalidAgent } })
        : new Response("## UNTRUSTED PARTICIPANT MESSAGES\nnpx --yes @0000chat/msg@latest post", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === `/${room}` && request.method === "GET") {
      if (request.headers.get("accept") !== "application/json") {
       return new Response(url.searchParams.get("view") === "human"
          ? missingHumanBanner ? `<!doctype html><main data-room="${room}"></main><script src="/_msg/asset/client.js"></script>` : `<!doctype html><aside class="view-banner human-view-banner">I'm an agent</aside><main data-room="${room}"></main><script src="/_msg/asset/client.js"></script>`
          : "<!doctype html><aside class=\"view-banner agent-view-banner\">I'm human</aside><h2>Untrusted conversation content</h2>", { headers: { "content-type": "text/html" } });
      }
      return deleted
        ? json({ error: { code: "gone" } }, 410)
        : json({ latest_message: 1, messages: [{ sequence: 1 }], protocol_version: 1 });
    }
    if (url.pathname === `/${room}` && request.method === "POST") return json({ message: { sequence: 2 }, protocol_version: 1, replayed: false }, 201);
    if (url.pathname === `/${room}/export.json`) return request.headers.get("accept") === "application/json"
      ? json({ messages: [{ sequence: 1 }, { sequence: 2 }], protocol_version: 1 })
      : new Response("# Export", { headers: { "content-type": "text/markdown" } });
    if (url.pathname === `/manage/${room}/${management}` && request.method === "DELETE") {
      deleted = true;
      return json({ deleted: true, protocol_version: 1 });
    }
    return new Response(null, { status: 404 });
  };

  await runProductionSynthetic({
    fetch,
    origin,
    report: (phase) => reports.push(phase),
    webSocket: async () => undefined,
  });

  expect(reports).toEqual(expect.arrayContaining(["health", "discovery", "browser home", "create", "browser room", "read", "agent", "post", "live", "export", "delete", "tombstone", "cleanup"]));
  expect(reports.join(" ")).not.toContain(room);
  expect(reports.join(" ")).not.toContain(management);
  expect(requests.filter((request) => request.path === "/" && request.method === "POST")).toHaveLength(2);
  expect(requests.filter((request) => request.path === "/" && request.method === "GET").length).toBeGreaterThanOrEqual(3);
  expect(requests.filter((request) => request.path === `/${room}` && request.method === "POST")).toHaveLength(2);
  expect(requests.filter((request) => request.path === `/${room}/agent` && request.method === "GET")).toHaveLength(2);
  expect(requests.some((request) => request.path === `/manage/${room}/${management}` && request.method === "DELETE")).toBe(true);
  expect(getPostCalled).toBe(false);

  deleted = false;
  const optionalReports: string[] = [];
  await runProductionSynthetic({ fetch, origin, getPost: true, report: (phase) => optionalReports.push(phase), webSocket: async () => undefined });
  expect(optionalReports).toContain("get-post");
  expect(getPostRequestWasCrossSite).toBe(true);

 missingHumanBanner = true;
 deleted = false;
  await expect(runProductionSynthetic({ fetch, origin, report: () => {}, webSocket: async () => undefined })).rejects.toThrow("human browser home");
missingHumanBanner = false;

  invalidAgent = true;
  deleted = false;
  await expect(runProductionSynthetic({ fetch, origin, report: () => {}, webSocket: async () => undefined })).rejects.toThrow("agent representation");
  expect(deleted).toBe(true);
});

test("still removes a created room when a verification phase fails", async () => {
  const origin = "https://msg.example.test";
  const room = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const management = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let deleted = false;

  await expect(runProductionSynthetic({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return json({ ok: true, protocol_version: 1 });
      if (["/agent.txt", "/llms.txt"].includes(url.pathname)) return new Response("safe discovery");
      if (url.pathname === "/openapi.json") return json({ openapi: "3.1.0" });
      if (url.pathname === "/" && request.method === "GET") return new Response(url.searchParams.get("view") === "human" ? '<aside class="view-banner human-view-banner">I\'m an agent</aside>Start a temporary conversation /_msg/asset/client.js' : '<aside class="view-banner agent-view-banner">I\'m human</aside>Trusted service instructions');
     if (url.pathname === "/" && request.method === "POST") return json({ conversation_url: `${origin}/${room}`, manage_url: `${origin}/manage/${room}/${management}`, protocol_version: 1, room: { id: room }, share_message: "Join", wait: { after: 1, command: "wait", requires_user_consent: true } }, 201);
      if (url.pathname === `/${room}` && request.method === "GET") {
        if (request.headers.get("accept") === "text/html") return new Response(url.searchParams.get("view") === "human" ? `<aside class="view-banner human-view-banner">I'm an agent</aside>data-room="${room}" /_msg/asset/client.js` : '<aside class="view-banner agent-view-banner">I\'m human</aside>Untrusted conversation content');
        return new Response(null, { status: 503 });
      }
      if (url.pathname === `/manage/${room}/${management}` && request.method === "DELETE") {
        deleted = true;
        return json({ deleted: true, protocol_version: 1 });
      }
      return new Response(null, { status: 404 });
    },
    origin,
    report: () => {},
  })).rejects.toThrow("read");

  expect(deleted).toBe(true);
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

import { expect, test } from "bun:test";

import { redirectLegacyBrowserRequest } from "./host";

test("redirects legacy browser room and management URLs while preserving path and query", () => {
  const request = new Request("https://msg.0000.chat/manage/room-1/private-token?recover=1&view=agent", {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  const response = redirectLegacyBrowserRequest(request, "https://0000.chat", "https://msg.0000.chat");
  expect(response?.status).toBe(301);
  expect(response?.headers.get("location")).toBe("https://0000.chat/manage/room-1/private-token?recover=1&view=agent");
});

test("redirects browser HEAD requests and leaves API and state-changing requests on legacy", () => {
  const head = redirectLegacyBrowserRequest(new Request("https://msg.0000.chat/room-1?after=4", { method: "HEAD" }), "https://0000.chat", "https://msg.0000.chat");
  expect(head?.status).toBe(301);

  const api = redirectLegacyBrowserRequest(new Request("https://msg.0000.chat/room-1?after=4", { headers: { accept: "application/json" } }), "https://0000.chat", "https://msg.0000.chat");
  expect(api).toBeUndefined();

  const post = redirectLegacyBrowserRequest(new Request("https://msg.0000.chat/mcp", { method: "POST", body: "{}" }), "https://0000.chat", "https://msg.0000.chat");
  expect(post).toBeUndefined();
});

test("supports a reversed compatibility configuration and local origins", () => {
  const reversed = redirectLegacyBrowserRequest(new Request("https://0000.chat/room-1?view=agent", { headers: { accept: "text/html" } }), "https://msg.0000.chat", "https://0000.chat");
  expect(reversed?.headers.get("location")).toBe("https://msg.0000.chat/room-1?view=agent");

  const local = redirectLegacyBrowserRequest(new Request("http://127.0.0.1:8787/room-1", { headers: { accept: "text/html" } }), "http://127.0.0.1:8787", "https://msg.0000.chat");
  expect(local).toBeUndefined();
});

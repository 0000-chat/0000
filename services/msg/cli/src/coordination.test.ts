import { expect, test } from "bun:test";

import { runCli } from "./cli.js";
import { parseCoordinationCommand } from "./coordination.js";

const roomUrl = "https://msg.0000.chat/room-1";
const managementUrl = "https://msg.0000.chat/manage/room-1/private-owner/coordination/publish";

test("parses bounded coordination reads and private publication commands", () => {
  expect(parseCoordinationCommand(["coordination", roomUrl, "overview"])).toEqual({ conversationUrl: roomUrl, operation: "overview" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "proposals", "--after", "2", "--limit", "5", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, limit: 5, operation: "proposals", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "proposal", "proposal-1", "--revision", "2"])).toEqual({ conversationUrl: roomUrl, id: "proposal-1", operation: "proposal", revision: 2 });
  expect(parseCoordinationCommand(["coordination", "publish", managementUrl])).toEqual({ managementUrl, operation: "publish" });
  expect(() => parseCoordinationCommand(["coordination", roomUrl, "proposals", "--limit", "101"])).toThrow("Usage: msg coordination");
});

test("uses public reads and JSON stdin for mutation routes without printing the management URL", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: init?.body === undefined ? undefined : String(init.body), method: init?.method, url: String(input) });
    return String(input) === managementUrl
      ? Response.json({ coordination_cursor: 2, expires_at: "2026-09-21T00:00:00.000Z", latest_message: 1, protocol_version: 1, published_revision: 1, replayed: false, request: { request_id: "request-1" }, proposal: { proposal_id: "proposal-1", request_id: "request-1", revision: 1 } })
      : Response.json({ coordination_cursor: 1, expires_at: "2026-09-21T00:00:00.000Z", latest_message: 1, protocol_version: 1, replayed: false, proposal: { proposal_id: "proposal-1", request_id: "request-1", revision: 1 }, revisions: [] });
  };
  const dependencies = {
    fetch,
    readStdin: async () => JSON.stringify({ actor_label: "agent", base_revision: 0, body: { completion_criteria: [], decision_impact: "none", owner_label: "owner", purpose: "purpose", requested_output: "output", title: "title", unknowns: [] }, client_retry_id: "retry-1", kind: "request.create", source_message_ids: [] }),
    stderr: (text: string) => stderr.push(text),
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  };
  expect(await runCli(["coordination", roomUrl, "propose"], dependencies)).toBe(0);
  expect(await runCli(["coordination", "publish", managementUrl], { ...dependencies, readStdin: async () => JSON.stringify({ base_revision: 0, client_retry_id: "publish-1", owner_label: "owner", proposal_id: "proposal-1", revision: 1 }) })).toBe(0);
  expect(calls).toEqual([
    { body: expect.any(String), method: "POST", url: `${roomUrl}/coordination/proposals` },
    { body: expect.any(String), method: "POST", url: managementUrl },
  ]);
  expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ proposal: { proposal_id: "proposal-1", request_id: "request-1", revision: 1 }, replayed: false });
  expect(stdout.join("")).not.toContain(managementUrl);
  expect(stdout.join("")).not.toContain("private-owner");
  expect(stderr).toEqual([]);
});

test("rejects malformed successful proposal and publication receipts without echoing the capability URL", async () => {
  const proposalErrors: string[] = [];
  const publicationErrors: string[] = [];
  const proposalResult = await runCli(["coordination", roomUrl, "propose"], {
    fetch: async () => Response.json({ replayed: false, proposal: { proposal_id: "proposal-1", request_id: "request-1" } }),
    readStdin: async () => "{}",
    stderr: (text: string) => proposalErrors.push(text),
    stdout: () => undefined,
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  const publicationResult = await runCli(["coordination", "publish", managementUrl], {
    fetch: async () => Response.json({ published_revision: 1, proposal: { proposal_id: "proposal-1", revision: 1 }, replayed: false, request: {} }),
    readStdin: async () => "{}",
    stderr: (text: string) => publicationErrors.push(text),
    stdout: () => undefined,
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  expect(proposalResult).toBe(1);
  expect(publicationResult).toBe(1);
  expect(proposalErrors.join("")).toContain("incomplete");
  expect(publicationErrors.join("")).toContain("incomplete");
  expect(proposalErrors.join("")).not.toContain(managementUrl);
  expect(publicationErrors.join("")).not.toContain(managementUrl);
});

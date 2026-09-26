import { expect, test } from "bun:test";

import { runCli } from "./cli.js";
import { parseCoordinationCommand } from "./coordination.js";

const roomUrl = "https://msg.0000.chat/room-1";
const managementUrl = "https://msg.0000.chat/manage/room-1/private-owner/coordination/publish";

test("parses bounded coordination reads and private publication commands", () => {
  expect(parseCoordinationCommand(["coordination", roomUrl, "overview"])).toEqual({ conversationUrl: roomUrl, operation: "overview" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "panel"])).toEqual({ conversationUrl: roomUrl, operation: "panel" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "panel", "--revision", "2"])).toEqual({ conversationUrl: roomUrl, operation: "panel", revision: 2 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "panel-history", "--after", "2", "--limit", "5", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, limit: 5, operation: "panel-history", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "proposals", "--after", "2", "--limit", "5", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, limit: 5, operation: "proposals", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "requests", "--after", "2", "--limit", "5", "--owner-label", "owner-a", "--status", "blocked", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, limit: 5, operation: "requests", ownerLabel: "owner-a", status: "blocked", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "proposal", "proposal-1", "--revision", "2"])).toEqual({ conversationUrl: roomUrl, id: "proposal-1", operation: "proposal", revision: 2 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "decisions", "--after", "2", "--limit", "5", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, limit: 5, operation: "decisions", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "decision", "decision-1", "--after", "2", "--limit", "5", "--through", "7"])).toEqual({ after: 2, conversationUrl: roomUrl, id: "decision-1", limit: 5, operation: "decision", through: 7 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "decision-record", "decision-1", "accepted-1"])).toEqual({ conversationUrl: roomUrl, decisionId: "decision-1", operation: "decision-record", recordId: "accepted-1" });
  expect(parseCoordinationCommand(["coordination", "publish", managementUrl])).toEqual({ managementUrl, operation: "publish" });
  expect(() => parseCoordinationCommand(["coordination", roomUrl, "proposals", "--limit", "101"])).toThrow("Usage: msg coordination");
  expect(() => parseCoordinationCommand(["coordination", roomUrl, "requests", "--status", "reported"])).toThrow("Usage: msg coordination");
});

test("reads decision history and immutable accepted records through public routes", async () => {
  const calls: string[] = [];
  const stdout: string[] = [];
  const fetch = async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ decision: { state: "accepted" }, accepted_record: { accepted_record_id: "accepted-1" }, approvals: [], decisions: [], published_revision: 4, through: 7 }); };
  expect(await runCli(["coordination", roomUrl, "decisions", "--after", "2", "--limit", "5", "--through", "7"], { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(await runCli(["coordination", roomUrl, "decision", "decision-1", "--after", "2", "--limit", "5", "--through", "7"], { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(await runCli(["coordination", roomUrl, "decision-record", "decision-1", "accepted-1"], { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(calls).toEqual([
    `${roomUrl}/coordination/decisions?after=2&limit=5&through=7`,
    `${roomUrl}/coordination/decisions/decision-1?after=2&limit=5&through=7`,
    `${roomUrl}/coordination/decisions/decision-1/records/accepted-1`,
  ]);
});

test("reads panel and panel history through the public room paths", async () => {
  const calls: string[] = [];
  const stdout: string[] = [];
  const fetch = async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ panel: null, events: [], published_revision: 3, coordination_cursor: 4 }); };
  expect(await runCli(["coordination", roomUrl, "panel", "--revision", "2"], { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(await runCli(["coordination", roomUrl, "panel-history", "--after", "1", "--limit", "5", "--through", "4"], { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(calls).toEqual([
    `${roomUrl}/coordination/panel?revision=2`,
    `${roomUrl}/coordination/panel/history?after=1&limit=5&through=4`,
  ]);
});

test("sends exact owner and canonical status selectors for bounded request reads", async () => {
  const calls: string[] = [];
  const stdout: string[] = [];
  const result = await runCli(["coordination", roomUrl, "requests", "--after", "2", "--limit", "1", "--owner-label", "owner a", "--status", "done", "--through", "7"], {
    fetch: async (input) => { calls.push(String(input)); return Response.json({ requests: [], has_more: false, next_after: 2, through: 7 }); },
    stderr: () => undefined,
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  expect(result).toBe(0);
  const url = new URL(calls[0] ?? "https://invalid.example");
  expect(url.pathname).toBe("/room-1/coordination/requests");
  expect([...url.searchParams.entries()]).toEqual([["after", "2"], ["limit", "1"], ["owner_label", "owner a"], ["status", "done"], ["through", "7"]]);
  expect(JSON.parse(stdout.join(""))).toMatchObject({ requests: [], through: 7 });
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

test("accepts a panel publication receipt without inventing a request ID", async () => {
  const stdout: string[] = [];
  const result = await runCli(["coordination", "publish", managementUrl], {
    fetch: async () => Response.json({ published_revision: 2, panel: { proposal_id: "panel-proposal" }, proposal: { proposal_id: "panel-proposal", revision: 1 }, replayed: false }),
    readStdin: async () => JSON.stringify({ base_revision: 1, client_retry_id: "panel-publish", owner_label: "owner", proposal_id: "panel-proposal", revision: 1 }),
    stderr: () => undefined,
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  expect(result).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({ published_revision: 2, panel: { proposal_id: "panel-proposal" } });
});

test("validates decision proposal and publication receipts without fake request or panel IDs", async () => {
  const stdout: string[] = [];
  const proposalResult = await runCli(["coordination", roomUrl, "propose"], {
    fetch: async () => Response.json({ replayed: false, proposal: { kind: "decision.proposal", proposal_id: "decision-1", request_id: null, revision: 1 } }),
    readStdin: async () => JSON.stringify({ actor_label: "agent", base_revision: 0, body: { proposal_text: "Ship", required_approver_labels: ["alice"], title: "Ship" }, client_retry_id: "decision-1", kind: "decision.proposal", source_message_ids: ["source-1"] }),
    stderr: () => undefined,
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  const publishResult = await runCli(["coordination", "publish", managementUrl], {
    fetch: async () => Response.json({ accepted_record: { accepted_record_id: "accepted-1" }, decision: { decision_id: "decision-1", state: "accepted" }, published_revision: 2, proposal: { proposal_id: "decision-1", revision: 1 }, replayed: false }),
    readStdin: async () => JSON.stringify({ base_revision: 0, client_retry_id: "decision-publish", decision_publication: { approvals: [{ participant_label: "alice", source_message_id: "source-1" }], mode: "acceptance", owner_attestation: true }, owner_label: "owner", proposal_id: "decision-1", revision: 1 }),
    stderr: () => undefined,
    stdout: (text: string) => stdout.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  expect(proposalResult).toBe(0);
  expect(publishResult).toBe(0);
  expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({ proposal: { kind: "decision.proposal", request_id: null } });
  expect(JSON.parse(stdout[1] ?? "{}")).toMatchObject({ accepted_record: { accepted_record_id: "accepted-1" } });
});

test("parses exact correction, report, supersession, publication, and review commands", () => {
  expect(parseCoordinationCommand(["coordination", roomUrl, "publication", "9"])).toEqual({ conversationUrl: roomUrl, operation: "publication", revision: 9 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "corrections", "--target-type", "publication", "--target-published-revision", "4", "--target-claim-path", '["claim","title"]', "--through", "8"])).toEqual({ conversationUrl: roomUrl, operation: "corrections", targetClaimPath: ["claim", "title"], targetPublishedRevision: 4, targetType: "publication", through: 8 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "correction", "correction-1"])).toEqual({ conversationUrl: roomUrl, id: "correction-1", operation: "correction" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "disputes", "--accepted-record-id", "accepted-1", "--kind", "approval_withdrawal", "--limit", "5", "--through", "8"])).toEqual({ acceptedRecordId: "accepted-1", conversationUrl: roomUrl, kind: "approval_withdrawal", limit: 5, operation: "disputes", through: 8 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "dispute", "report-1", "--after", "2", "--limit", "5", "--through", "8"])).toEqual({ after: 2, conversationUrl: roomUrl, id: "report-1", limit: 5, operation: "dispute", through: 8 });
  expect(parseCoordinationCommand(["coordination", roomUrl, "supersessions", "--predecessor-accepted-record-id", "accepted-1", "--successor-decision-id", "decision-2"])).toEqual({ conversationUrl: roomUrl, operation: "supersessions", predecessorAcceptedRecordId: "accepted-1", successorDecisionId: "decision-2" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "correct"])).toEqual({ conversationUrl: roomUrl, operation: "correct" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "supersede"])).toEqual({ conversationUrl: roomUrl, operation: "supersede" });
  expect(parseCoordinationCommand(["coordination", roomUrl, "report"])).toEqual({ conversationUrl: roomUrl, operation: "report" });
  expect(parseCoordinationCommand(["coordination", "review", managementUrl, "report-1"])).toEqual({ managementUrl, operation: "review", reportId: "report-1" });
  expect(() => parseCoordinationCommand(["coordination", roomUrl, "corrections", "--target-type", "message", "--target-claim-path", '["claim"]'])).toThrow("Usage: msg coordination");
});

test("reads exact ticket11 coordination routes with bounded selectors", async () => {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ corrections: [], disputes: [], supersessions: [], through: 8, has_more: false, next_after: 0, publication: {}, correction: {}, dispute: {}, reviews: [] }); };
  const dependencies = { fetch, stderr: () => undefined, stdout: () => undefined, websocket: () => { throw new Error("WebSocket must not connect."); } };
  expect(await runCli(["coordination", roomUrl, "publication", "9"], dependencies)).toBe(0);
  expect(await runCli(["coordination", roomUrl, "corrections", "--target-type", "publication", "--target-published-revision", "4", "--target-claim-path", '["claim","title"]', "--after", "2", "--limit", "5", "--through", "8"], dependencies)).toBe(0);
  expect(await runCli(["coordination", roomUrl, "correction", "correction-1"], dependencies)).toBe(0);
  expect(await runCli(["coordination", roomUrl, "disputes", "--accepted-record-id", "accepted-1", "--kind", "approval_withdrawal", "--after", "2", "--limit", "5", "--through", "8"], dependencies)).toBe(0);
  expect(await runCli(["coordination", roomUrl, "dispute", "report-1", "--after", "2", "--limit", "5", "--through", "8"], dependencies)).toBe(0);
  expect(await runCli(["coordination", roomUrl, "supersessions", "--predecessor-accepted-record-id", "accepted-1", "--successor-decision-id", "decision-2", "--after", "2", "--limit", "5", "--through", "8"], dependencies)).toBe(0);
  expect(calls).toEqual([
    `${roomUrl}/coordination/publications/9`,
    `${roomUrl}/coordination/corrections?after=2&limit=5&target_type=publication&target_published_revision=4&target_claim_path=%5B%22claim%22%2C%22title%22%5D&through=8`,
    `${roomUrl}/coordination/corrections/correction-1`,
    `${roomUrl}/coordination/disputes?after=2&limit=5&accepted_record_id=accepted-1&kind=approval_withdrawal&through=8`,
    `${roomUrl}/coordination/disputes/report-1?after=2&limit=5&through=8`,
    `${roomUrl}/coordination/supersessions?after=2&limit=5&predecessor_accepted_record_id=accepted-1&successor_decision_id=decision-2&through=8`,
  ]);
});

test("sends typed correction, supersession, report, and owner-review receipts", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const stdout: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const body = init?.body === undefined ? undefined : String(init.body); calls.push({ body, method: init?.method, url });
    if (url.endsWith("/coordination/proposals")) {
      const parsed = JSON.parse(body ?? "{}");
      return Response.json({ proposal: { kind: parsed.kind, proposal_id: `${parsed.kind}-1`, revision: 1 }, replayed: false });
    }
    if (url.endsWith("/coordination/disputes")) return Response.json({ dispute: { report_id: "report-1" }, replayed: false });
    return Response.json({ replayed: false, review: { report_id: "report-1", review_id: "review-1" } });
  };
  const base = { fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } };
  expect(await runCli(["coordination", roomUrl, "correct"], { ...base, readStdin: async () => JSON.stringify({ actor_label: "reporter", base_revision: 4, body: { correction_text: "Corrected", target: { message_id: "message-1", type: "message" } }, client_retry_id: "correction-1", kind: "claim.correction", source_message_ids: [] }) })).toBe(0);
  expect(await runCli(["coordination", roomUrl, "supersede"], { ...base, readStdin: async () => JSON.stringify({ actor_label: "reporter", base_revision: 4, body: { predecessor_accepted_record_id: "accepted-1", successor_decision_id: "decision-2", successor_decision_revision: 2 }, client_retry_id: "supersession-1", kind: "decision.supersession", source_message_ids: [] }) })).toBe(0);
  expect(await runCli(["coordination", roomUrl, "report"], { ...base, readStdin: async () => JSON.stringify({ accepted_record_id: "accepted-1", actor_label: "reporter", approval_record_id: "approval-1", client_retry_id: "report-1", kind: "approval_withdrawal", source_message_ids: [], statement: "Disputed approval." }) })).toBe(0);
  expect(await runCli(["coordination", "review", managementUrl, "report-1"], { ...base, readStdin: async () => JSON.stringify({ base_revision: 4, client_retry_id: "review-1", disposition: "acknowledged", owner_label: "owner", rationale: "Reviewed.", source_message_ids: [] }) })).toBe(0);
  expect(calls.map((call) => call.url)).toEqual([`${roomUrl}/coordination/proposals`, `${roomUrl}/coordination/proposals`, `${roomUrl}/coordination/disputes`, "https://msg.0000.chat/manage/room-1/private-owner/coordination/disputes/report-1/review"]);
  expect(JSON.parse(calls[0]!.body ?? "{}").kind).toBe("claim.correction");
  expect(JSON.parse(calls[1]!.body ?? "{}").kind).toBe("decision.supersession");
  expect(JSON.parse(calls[2]!.body ?? "{}").approval_record_id).toBe("approval-1");
  expect(JSON.parse(calls[3]!.body ?? "{}")).not.toHaveProperty("report_id");
  expect(stdout).toHaveLength(4);
});

test("CLI help names ticket11 coordination commands", async () => {
  const stdout: string[] = [];
  expect(await runCli(["--help"], { fetch: globalThis.fetch, stderr: () => undefined, stdout: (text: string) => stdout.push(text), websocket: () => { throw new Error("WebSocket must not connect."); } })).toBe(0);
  expect(stdout.join("")).toContain("publication <published-revision>");
  expect(stdout.join("")).toContain("corrections [selectors]");
  expect(stdout.join("")).toContain("review <management-coordination-url> <report-id>");
});

import { expect, test } from "bun:test";
import { runCli, type CliDependencies } from "./cli";

const origin = "http://localhost:8791";
const source = origin + "/" + "a".repeat(43);
const target = origin + "/" + "b".repeat(43);
const managementUrl = origin + "/manage/" + "b".repeat(43) + "/private-owner";
const sourcePageUrl = (sequence: number) => `${source}?after=${sequence - 1}&through=${sequence}&limit=1`;
const sourcePage = (sequence: number) => ({ conversation_url: source, protocol_version: 1, latest_message: 100, through: sequence, next_after: sequence, has_more: false, messages: [{ id: `message-${sequence}`, sequence, content: "Do not copy this whole transcript" }] });
const group = origin + "/g/" + "c".repeat(43);
function fixture(fetch: typeof globalThis.fetch) {
  const stdout: string[] = [], stderr: string[] = [];
  const deps: CliDependencies = { fetch, stdout: text => stdout.push(text), stderr: text => stderr.push(text), generatedClientMessageId: () => "stable-create-id", readStdin: async () => "", stdinIsTTY: true, sleep: async () => {}, websocket: () => { throw Error("Must not listen automatically"); } };
  return { stdout, stderr, deps };
}
function creation() { return { protocol_version: 1, conversation_url: target, share_message: "Join " + target, room: { id: "b".repeat(43) }, manage_url: managementUrl, wait: { after: 1, requires_user_consent: true } }; }

test("create reads selected context from stdin and stays on the requested local origin", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const { deps, stdout, stderr } = fixture(async (url, init) => { calls.push({ url: String(url), init }); return Response.json(creation(), { status: 201 }); });
  const code = await runCli(["create", "--origin", origin, "--title", "Research", "--author", "Agent A"], { ...deps, stdinIsTTY: false, readStdin: async () => "Selected context\n\nA focused question" });
  expect(stderr).toEqual([]);
  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(origin + "/");
  expect(calls[0].init?.redirect).toBe("error");
  expect(new Headers(calls[0].init?.headers).get("idempotency-key")).toBe("stable-create-id");
  expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ title: "Research", content: "Selected context\n\nA focused question", author: "Agent A" });
  expect(JSON.parse(stdout[0]).conversation_url).toBe(target);
  const receipt = JSON.parse(stdout[0]);
  expect(receipt.manage_url).toBe(managementUrl);
  expect(receipt.share_message).not.toContain("private-owner");
  expect(receipt.join_command).not.toContain("private-owner");
});

test("branch validates the source, creates selected context and links both chats without posting a summary", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const { deps, stdout, stderr } = fixture(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url) === sourcePageUrl(4)) return Response.json(sourcePage(4));
    if (String(url) === origin + "/") return Response.json(creation(), { status: 201 });
    return Response.json({ links: [] });
  });
  const code = await runCli(["branch", source, "--from", "4", "--title", "Pricing", "--author", "Agent A", "--content", "Only selected context"], deps);
  expect(stderr).toEqual([]);
  expect(code).toBe(0);
  expect(calls.map(call => call.url)).toEqual([sourcePageUrl(4), origin + "/", source + "/links"]);
  expect(calls[1].body).toMatchObject({ content: "Only selected context", title: "Pricing" });
  expect(calls[2].body).toEqual({ conversation_url: target, source_message: 4 });
  expect(JSON.parse(stdout[0])).toMatchObject({ conversation_url: target, source_url: source, linked: true });
});

test("failed branch linking returns the created chat and a link-only recovery command", async () => {
  let creates = 0;
  const { deps, stdout, stderr } = fixture(async url => {
    if (String(url) === sourcePageUrl(1)) return Response.json(sourcePage(1));
    if (String(url) === origin + "/") { creates++; return Response.json(creation(), { status: 201 }); }
    return Response.json({ error: { message: "Link unavailable" } }, { status: 503 });
  });
  expect(await runCli(["branch", source, "--from", "1", "--title", "Detail", "--author", "A", "--content", "Context"], deps)).toBe(1);
  expect(creates).toBe(1);
  expect(JSON.parse(stdout[0])).toMatchObject({ conversation_url: target, linked: false, manage_url: managementUrl });
  expect(JSON.parse(stdout[0]).recovery_command).toContain(" links ");
  expect(JSON.parse(stdout[0]).recovery_command).toContain("--from 1");
  expect(stderr.join("")).toContain("created");
});

test("groups and links dispatch idempotent operations without creating new rooms", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const { deps } = fixture(async (url, init) => { calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return Response.json({ links: [], chats: [], group_url: group, name: "Project", expires_at: "2026-10-21T00:00:00Z" }); });
  for (const args of [
    ["groups", "create", "--origin", origin, "--name", "Project"],
    ["groups", group, "list"], ["groups", group, "add", source], ["groups", group, "remove", source], ["groups", group, "rename", "New name"],
    ["links", source, "list"], ["links", source, "add", target], ["links", source, "remove", target],
  ]) expect(await runCli(args, deps)).toBe(0);
  expect(calls.map(call => call.method)).toEqual(["POST", "GET", "POST", "DELETE", "PATCH", "GET", "POST", "DELETE"]);
  expect(calls[2].body).toEqual({ conversation_url: source });
  expect(calls[4].body).toEqual({ name: "New name" });
  expect(calls[6].body).toEqual({ conversation_url: target });
  expect(calls[7].url).toBe(source + "/links/" + "b".repeat(43));
});

test("an interrupted link preserves the branch receipt and exits with the signal status", async () => {
  const controller = new AbortController();
  const { deps, stdout } = fixture(async url => {
    if (String(url) === sourcePageUrl(1)) return Response.json(sourcePage(1));
    if (String(url) === origin + "/") return Response.json(creation(), { status: 201 });
    controller.abort();
    throw new DOMException("Interrupted", "AbortError");
  });
  expect(await runCli(["branch", source, "--from", "1", "--title", "Detail", "--author", "A", "--content", "Context"], { ...deps, signal: controller.signal })).toBe(130);
  expect(JSON.parse(stdout[0])).toMatchObject({ conversation_url: target, linked: false, manage_url: managementUrl });
  expect(JSON.parse(stdout[0]).recovery_command).toContain(" links ");
});

test("a nonexistent source message stops a branch before creating a chat", async () => {
  const calls: string[] = [];
  const { deps, stdout, stderr } = fixture(async url => {
    calls.push(String(url));
    return Response.json({ ...sourcePage(2), messages: [] });
  });
  expect(await runCli(["branch", source, "--from", "2", "--title", "Detail", "--author", "A", "--content", "Context"], deps)).toBe(1);
  expect(calls).toEqual([sourcePageUrl(2)]);
  expect(stdout).toEqual([]);
  expect(stderr.join("")).toContain("No new chat was created");
});

test("rejects unsafe origins, cross-origin links and invalid options before making requests", async () => {
  let requests = 0;
  const { deps } = fixture(async () => { requests++; return Response.json({}); });
  for (const args of [
    ["create", "--origin", "http://192.168.1.2", "--author", "A", "--content", "test"],
    ["create", "--origin", "https://evil.test", "--author", "A", "--content", "test"],
    ["links", source, "add", "https://msg.0000.chat/" + "b".repeat(43)],
    ["links", source, "add", target, "--from", "0"],
    ["branch", source, "--from", "1", "--from", "2", "--title", "T", "--author", "A", "--content", "X"],
    ["groups", origin + "/manage/secret", "list"],
    ["links", source + "?token=secret", "list"],
  ]) expect(await runCli(args, deps)).toBe(1);
  expect(requests).toBe(0);
});

test("does not blindly retry an uncertain creation response", async () => {
  let creates = 0;
  const { deps, stderr } = fixture(async () => { creates++; throw Error("Connection lost"); });
  expect(await runCli(["create", "--origin", origin, "--author", "A", "--content", "Context"], deps)).toBe(1);
  expect(creates).toBe(1);
  expect(stderr.join("")).toContain("stable-create-id");
});

test("explicit summary post supports reply sequence and semantic type", async () => {
  let sent: unknown;
  const { deps, stderr } = fixture(async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ message: { id: "summary-2", created_at: "2026-09-21T00:00:00.000Z", sequence: 2 }, replayed: false, wait: { after: 2, requires_user_consent: true } });
  });
  expect(await runCli(["post", source, "--author", "A", "--content", "Chosen conclusion", "--reply-to", "1", "--type", "result", "--based-on-sequence", "1"], deps)).toBe(0);
  expect(stderr).toEqual([]);
  expect(sent).toMatchObject({ content: "Chosen conclusion", reply_to: "1", semantic_type: "result", based_on_sequence: 1 });
});


test("creation rejects foreign, malformed or wrong-room ownership capabilities without exposing them", async () => {
  for (const manageUrl of [
    "https://evil.test/manage/" + "b".repeat(43) + "/private-owner",
    origin + "/manage/" + "a".repeat(43) + "/private-owner",
    managementUrl + "?private=1",
    origin + "/manage/private-owner",
  ]) {
    const { deps, stdout, stderr } = fixture(async () => Response.json({ ...creation(), manage_url: manageUrl }));
    expect(await runCli(["create", "--origin", origin, "--author", "A", "--content", "Context"], deps)).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).not.toContain("private-owner");
  }
});

test("branch source verification rejects a server ignoring the exact bounded message request", async () => {
  for (const page of [
    { conversation_url: source, latest_message: 100, messages: [{ sequence: 4 }] },
    { ...sourcePage(4), messages: [{ sequence: 3 }] },
    { ...sourcePage(4), through: 100 },
    { ...sourcePage(4), next_after: 3 },
    { ...sourcePage(4), has_more: true },
  ]) {
    const calls: string[] = [];
    const { deps, stdout } = fixture(async url => { calls.push(String(url)); return Response.json(page); });
    expect(await runCli(["branch", source, "--from", "4", "--title", "T", "--author", "A", "--content", "Context"], deps)).toBe(1);
    expect(calls).toEqual([sourcePageUrl(4)]);
    expect(stdout).toEqual([]);
  }
});


test.each(["create", "branch"])("%s preserves a successful creation receipt when cancellation arrives during JSON parsing", async action => {
  const controller = new AbortController();
  const calls: string[] = [];
  const { deps, stdout } = fixture(async url => {
    calls.push(String(url));
    if (String(url) === sourcePageUrl(1)) return Response.json(sourcePage(1));
    return { ok: true, status: 201, json: async () => { controller.abort(); return creation(); } } as unknown as Response;
  });
  const args = action === "branch" ? ["branch", source, "--from", "1", "--title", "T"] : ["create", "--origin", origin];
  expect(await runCli([...args, "--author", "A", "--content", "Context"], { ...deps, signal: controller.signal })).toBe(action === "branch" ? 130 : 0);
  const receipt = JSON.parse(stdout[0]);
  expect(receipt).toMatchObject({ conversation_url: target, manage_url: managementUrl, idempotency_key: "stable-create-id" });
  if (action === "branch") {
    expect(receipt.linked).toBe(false);
    expect(receipt.recovery_command).toContain(" links ");
  }
  expect(calls).toEqual(action === "branch" ? [sourcePageUrl(1), origin + "/"] : [origin + "/"]);
});

test("an uncertain cancelled creation retains its idempotency key for outcome reconciliation", async () => {
  const controller = new AbortController();
  const { deps, stdout, stderr } = fixture(async () => { controller.abort(); throw new DOMException("Interrupted", "AbortError"); });
  expect(await runCli(["create", "--origin", origin, "--author", "A", "--content", "Context"], { ...deps, signal: controller.signal })).toBe(130);
  expect(stdout).toEqual([]);
  expect(stderr.join("")).toContain("stable-create-id");
  expect(stderr.join("")).toContain("Check the service before retrying");
});

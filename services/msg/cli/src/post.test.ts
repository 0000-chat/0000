import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";

import { parsePostCommand, postMessage } from "./post";

const conversationUrl = "https://msg.0000.chat/room-1";

test("parses a post command with inline content", () => {
  expect(parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--content", "Hello"])).toEqual({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
  });
});

test("parses optional display name and name password while keeping author required", () => {
  expect(parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--display-name", "Agent Alpha", "--name-password", "chosen secret", "--content", "Hello"])).toEqual({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    displayName: "Agent Alpha",
    namePassword: "chosen secret",
  });
  expect(() => parsePostCommand(["post", conversationUrl, "--display-name", "Agent Alpha", "--content", "Hello"])).toThrow("--author is required");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--display-name", ""])).toThrow("--display-name must not be empty");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--name-password", ""])).toThrow("--name-password must not be empty");
});

test("parses a post command for stdin content and preserves an explicit client message ID", () => {
  expect(parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--client-message-id", "stable-id"])).toEqual({
    author: "Agent A",
    clientMessageId: "stable-id",
    conversationUrl,
  });
});

test("parses and validates the optional stale-context precondition", () => {
  expect(parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--based-on-sequence", "0", "--content", "Hello"])).toEqual({
    author: "Agent A",
    basedOnSequence: 0,
    content: "Hello",
    conversationUrl,
  });
  for (const value of ["-1", "1.5", "01", "9007199254740992"]) {
    expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--based-on-sequence", value])).toThrow("--based-on-sequence must be a nonnegative safe integer");
  }
});

test("rejects invalid post command fields and flags", () => {
  expect(() => parsePostCommand(["post", "https://example.test/room-1", "--author", "Agent A"])).toThrow("https://msg.0000.chat/{room}");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", ""])).toThrow("--author must not be empty");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--content", ""])).toThrow("--content must not be empty");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--client-message-id", "x".repeat(129)])).toThrow("--client-message-id must be at most 128 characters");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--author", "Agent B"])).toThrow("may be provided only once");
  expect(() => parsePostCommand(["post", conversationUrl, "--author", "Agent A", "--unknown", "value"])).toThrow("Unknown post option");
});

test("retries an ambiguous transport failure with one generated client message ID", async () => {
  const bodies: unknown[] = [];
  const delays: number[] = [];
  let attempts = 0;

  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      attempts += 1;
      if (attempts === 1) throw new TypeError("network failed");
      return Response.json(successReceipt({ replayed: true }), { status: 201 });
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async (delay) => { delays.push(delay); },
  });

  expect(receipt).toEqual(publicReceipt("generated-id", true));
  expect(bodies).toEqual([
    { author: "Agent A", client_message_id: "generated-id", content: "Hello" },
    { author: "Agent A", client_message_id: "generated-id", content: "Hello" },
  ]);
  expect(delays).toEqual([250]);
});

test("retries an accepted response whose body read fails and keeps the committed message ID", async () => {
  const bodies: Array<{ author: string; client_message_id: string; content: string }> = [];
  const committed = new Set<string>();
  const cancelled: number[] = [];
  const delays: number[] = [];
  let attempts = 0;

  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { author: string; client_message_id: string; content: string };
      bodies.push(body);
      committed.add(body.client_message_id);
      attempts += 1;
      if (attempts === 1) {
        return {
          body: { cancel: async () => { cancelled.push(attempts); } },
          json: async () => { throw new TypeError("response stream reset after commit"); },
          ok: true,
          status: 201,
        } as unknown as Response;
      }
      return Response.json(successReceipt({ replayed: true }), { status: 201 });
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async (delay) => { delays.push(delay); },
  });

  expect(receipt).toEqual(publicReceipt("generated-id", true));
  expect(attempts).toBe(2);
  expect(committed).toEqual(new Set(["generated-id"]));
  expect(bodies).toEqual([
    { author: "Agent A", client_message_id: "generated-id", content: "Hello" },
    { author: "Agent A", client_message_id: "generated-id", content: "Hello" },
  ]);
  expect(cancelled).toEqual([1]);
  expect(delays).toEqual([250]);
});

test("preserves an explicit client message ID", async () => {
  let body: unknown;
  const receipt = await postMessage({
    author: "Agent A",
    clientMessageId: "caller-owned-id",
    content: "Hello",
    conversationUrl,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(successReceipt({ replayed: false }), { status: 201 });
    },
    generatedClientMessageId: () => { throw new Error("An explicit ID must not be replaced."); },
    sleep: async () => {},
  });

  expect(body).toEqual({ author: "Agent A", client_message_id: "caller-owned-id", content: "Hello" });
  expect(receipt).toEqual(publicReceipt("caller-owned-id", false));
});

test("sends display_name and name_password without exposing them in the message projection", async () => {
  let body: unknown;
  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    displayName: "Agent Alpha",
    namePassword: "caller-chosen password of any nonempty length",
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json(successReceipt({ replayed: false }), { status: 201 });
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  });

  expect(body).toEqual({ author: "Agent A", client_message_id: "generated-id", content: "Hello", display_name: "Agent Alpha", name_password: "caller-chosen password of any nonempty length" });
  expect(receipt).toEqual(publicReceipt("generated-id", false));
});

test("returns a generated first-claim password and emits a save warning", async () => {
  const statuses: string[] = [];
  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => Response.json({ ...successReceipt({ replayed: false }), name_password: "Ab3dE7x9", name_password_notice: "Save this password; it will not be shown again." }, { status: 201 }),
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
    status: (text) => statuses.push(text),
  });

  expect(receipt).toEqual({ ...publicReceipt("generated-id", false), name_password: "Ab3dE7x9", name_password_notice: "Save this password; it will not be shown again." });
  expect(statuses).toEqual(["Save this password; it will not be shown again."]);
});

test("rejects a generated name password unless it is exactly eight characters", async () => {
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => Response.json({ ...successReceipt({ replayed: false }), name_password: "short", name_password_notice: "Save this password; it will not be shown again." }, { status: 201 }),
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  })).rejects.toThrow("invalid post receipt");
});

test("sends based_on_sequence and reports stale conflicts without retrying", async () => {
  let attempts = 0;
  const stale = postMessage({
    author: "Agent A",
    basedOnSequence: 12,
    content: "Hello",
    conversationUrl,
    fetch: async (_input, init) => {
      attempts += 1;
      expect(JSON.parse(String(init?.body))).toEqual({ author: "Agent A", based_on_sequence: 12, client_message_id: "generated-id", content: "Hello" });
      return Response.json({ error: { code: "stale_sequence", latest_message: 14, message: "stale", review_after: 12 } }, { status: 409 });
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async () => { throw new Error("A stale post must not retry."); },
  });
  const error = await stale.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("msg join 'https://msg.0000.chat/room-1' --after 12 --through 14 --limit 20");
  expect((error as Error).message).toContain("explicitly resubmit");
  expect(attempts).toBe(1);
});

test("retries each retryable HTTP status with the bounded schedule", async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const delays: number[] = [];
    let attempts = 0;
    await expect(postMessage({
      author: "Agent A",
      content: "Hello",
      conversationUrl,
      fetch: async () => {
        attempts += 1;
        return attempts === 3 ? Response.json(successReceipt({ replayed: false }), { status: 201 }) : new Response("retry", { status });
      },
      generatedClientMessageId: () => "generated-id",
      sleep: async (delay) => { delays.push(delay); },
    })).resolves.toEqual(publicReceipt("generated-id", false));
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 1_000]);
  }
});

test("does not retry definite HTTP failures", async () => {
  for (const status of [400, 409, 410, 413, 501]) {
    let attempts = 0;
    await expect(postMessage({
      author: "Agent A",
      content: "Hello",
      conversationUrl,
      fetch: async () => {
        attempts += 1;
        return new Response("failed", { status });
      },
      generatedClientMessageId: () => "generated-id",
      sleep: async () => { throw new Error("A definite HTTP failure must not sleep."); },
    })).rejects.toThrow(`HTTP ${status}`);
    expect(attempts).toBe(1);
  }
});

test("fails invalid successful receipts without another POST or private response fields", async () => {
  let attempts = 0;
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => {
      attempts += 1;
      return Response.json({ manage_url: "https://msg.0000.chat/manage/room-1/private", message: { sequence: "2" }, replayed: false, wait: { after: 2, command: "wait" } }, { status: 201 });
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async () => { throw new Error("An invalid receipt must not retry."); },
  })).rejects.toThrow("invalid post receipt");
  expect(attempts).toBe(1);
});

test("stops before a request when the operation is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => { throw new Error("The request must not start."); },
    generatedClientMessageId: () => "generated-id",
    signal: controller.signal,
    sleep: async () => {},
  })).rejects.toThrow("interrupted");
});

test("does not return a successful receipt after the signal aborts during fetch", async () => {
  const controller = new AbortController();
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => {
      controller.abort();
      return Response.json(successReceipt({ replayed: false }), { status: 201 });
    },
    generatedClientMessageId: () => "generated-id",
    signal: controller.signal,
    sleep: async () => {},
  })).rejects.toThrow("interrupted");
});

test("normalizes abort errors from retry sleep and successful response parsing", async () => {
  const sleepController = new AbortController();
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => new Response("retry", { status: 503 }),
    generatedClientMessageId: () => "generated-id",
    signal: sleepController.signal,
    sleep: async () => {
      sleepController.abort();
      throw new DOMException("Aborted", "AbortError");
    },
  })).rejects.toThrow("interrupted");

  const parseController = new AbortController();
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => ({
      json: async () => {
        parseController.abort();
        throw new DOMException("Aborted", "AbortError");
      },
      ok: true,
      status: 201,
    }) as Response,
    generatedClientMessageId: () => "generated-id",
    signal: parseController.signal,
    sleep: async () => {},
  })).rejects.toThrow("interrupted");
});

test("cancels retryable and terminal HTTP response bodies", async () => {
  const cancelled: number[] = [];
  let attempts = 0;
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => {
      attempts += 1;
      const status = attempts === 1 ? 503 : 409;
      return responseWithCancellableBody(status, () => cancelled.push(status));
    },
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  })).rejects.toThrow("HTTP 409");
  expect(cancelled).toEqual([503, 409]);
});

test("cancels a non-success response body before reporting an abort", async () => {
  for (const status of [503, 409]) {
    const controller = new AbortController();
    let cancelled = false;
    await expect(postMessage({
      author: "Agent A",
      content: "Hello",
      conversationUrl,
      fetch: async () => {
        controller.abort();
        return responseWithCancellableBody(status, () => { cancelled = true; });
      },
      generatedClientMessageId: () => "generated-id",
      signal: controller.signal,
      sleep: async () => {},
    })).rejects.toThrow("interrupted");
    expect(cancelled).toBe(true);
  }
});

test("constructs the wait command instead of forwarding a server capability", async () => {
  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => Response.json({
      ...successReceipt({ replayed: false }),
    wait: { after: 2, command: "npx msg wait https://msg.0000.chat/manage/room-1/private --after 2", requires_user_consent: true },
    }, { status: 201 }),
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  });
  expect(receipt).toEqual(publicReceipt("generated-id", false));
  expect(JSON.stringify(receipt)).not.toContain("manage");
});

test("rejects a post receipt without explicit listening consent", async () => {
  await expect(postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl,
    fetch: async () => Response.json({
      message: { sequence: 2 },
      replayed: false,
      wait: { after: 2, command: "npx msg wait https://msg.0000.chat/room-1 --after 2" },
    }, { status: 201 }),
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  })).rejects.toThrow("invalid post receipt");
});

test("quotes a generated wait command as exact shell arguments", async () => {
  const craftedConversationUrl = "https://msg.0000.chat/room'$(printf)'tail";
  const canonicalConversationUrl = new URL(craftedConversationUrl).toString();
  const receipt = await postMessage({
    author: "Agent A",
    content: "Hello",
    conversationUrl: craftedConversationUrl,
    fetch: async () => Response.json(successReceipt({ replayed: false }), { status: 201 }),
    generatedClientMessageId: () => "generated-id",
    sleep: async () => {},
  });

  const output = execFileSync("sh", [
    "-c",
    "npx() { for item do printf '%s\\n' \"$item\"; done; }; eval \"$1\"",
    "msg-post-test",
    receipt.wait.command,
  ], { encoding: "utf8" });

  expect(output.trimEnd().split("\n")).toEqual([
    "--yes",
    "@0000chat/msg@latest",
    "wait",
    canonicalConversationUrl,
    "--after",
    "2",
  ]);
});

function successReceipt({ replayed }: { replayed: boolean }) {
  return {
    manage_url: "https://msg.0000.chat/manage/room-1/private",
    message: { content: "Hello", created_at: "2026-08-10T00:00:00.000Z", id: "message-2", sequence: 2 },
    replayed,
    wait: { after: 2, command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/room-1' --after 2", requires_user_consent: true },
  };
}

function publicReceipt(clientMessageId: string, replayed: boolean) {
  return {
    client_message_id: clientMessageId,
    conversation_url: conversationUrl,
    message: { created_at: "2026-08-10T00:00:00.000Z", id: "message-2", sequence: 2 },
    message_sequence: 2,
    replayed,
    wait: { after: 2, command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/room-1' --after 2", requires_user_consent: true },
  };
}

function responseWithCancellableBody(status: number, onCancel: () => void): Response {
  return {
    body: { cancel: async () => { onCancel(); } },
    ok: false,
    status,
  } as unknown as Response;
}

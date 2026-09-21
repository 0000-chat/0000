import { expect, test } from "bun:test";

import { runCli } from "./cli";
import { exportConversation, ExportSignalError, parseExportCommand } from "./export";

const conversationUrl = "https://msg.0000.chat/room-1";

test("parses export format and defaults to JSON", () => {
  expect(parseExportCommand(["export", conversationUrl])).toEqual({ conversationUrl, format: "json" });
  expect(parseExportCommand(["export", conversationUrl, "--format", "markdown"])).toEqual({ conversationUrl, format: "markdown" });
  expect(() => parseExportCommand(["export", conversationUrl, "--format", "yaml"])).toThrow("Usage: msg export");
});

test("preserves export bytes and requests the selected artifact", async () => {
  const chunks = [
    new Uint8Array([0x7b, 0x22, 0x6d]),
    new Uint8Array([0x73, 0x67, 0x22, 0x3a, 0x22, 0xf0, 0x9f, 0x98, 0x80, 0x22, 0x7d]),
  ];
  const output: number[] = [];
  let requested = "";
  let accept = "";
  let index = 0;
  await exportConversation({
    conversationUrl,
    fetch: async (input, init) => {
      requested = String(input);
      accept = new Headers(init?.headers).get("accept") ?? "";
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      }));
    },
    stdout: () => { throw new Error("the byte sink should be selected"); },
    stdoutBytes: async (chunk) => { output.push(...chunk); },
  });

  expect(requested).toBe(`${conversationUrl}/export.md`);
  expect(accept).toBe("text/markdown");
  expect(new Uint8Array(output)).toEqual(new Uint8Array(chunks.flatMap((chunk) => [...chunk])));
});

test("maps SIGINT while a byte sink is held and does not read ahead", async () => {
  const controller = new AbortController();
  let reads = 0;
  let cancelled = false;
  const stderr: string[] = [];
  let beginSink: (() => void) | undefined;
  const sinkStarted = new Promise<void>((resolve) => { beginSink = resolve; });
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return { done: false, value: new Uint8Array([0x7b]) };
        },
        cancel: async () => { cancelled = true; },
      }),
    },
  } as unknown as Response;

  const running = runCli(["export", conversationUrl], {
    fetch: async () => response,
    signal: controller.signal,
    stdout: () => undefined,
    stderr: (text) => stderr.push(text),
    stdoutBytes: async () => {
      beginSink?.();
      await new Promise<void>(() => {});
    },
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  await sinkStarted;
  controller.abort();

  await expect(running).resolves.toBe(130);
  expect(reads).toBe(1);
  expect(cancelled).toBe(true);
  expect(stderr).toEqual(["The msg export was interrupted.\n"]);
});

test("checks an abort that happens when fetch resolves before reading", async () => {
  const controller = new AbortController();
  let reads = 0;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return { done: true, value: undefined };
        },
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;

  await expect(exportConversation({
    conversationUrl,
    fetch: async () => {
      controller.abort();
      return response;
    },
    signal: controller.signal,
    stdout: () => undefined,
  })).rejects.toBeInstanceOf(ExportSignalError);
  expect(reads).toBe(0);
});

test("decodes UTF-8 split across chunks for the synchronous stdout fallback", async () => {
  const output: string[] = [];
  const bytes = new TextEncoder().encode('{"message":"😀"}');
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 13));
      controller.enqueue(bytes.slice(13));
      controller.close();
    },
  }));

  await exportConversation({
    conversationUrl,
    fetch: async () => response,
    stdout: (text) => output.push(text),
  });

  expect(output.join("")).toBe('{"message":"😀"}');
});

test("rejects non-200 responses and cancels their body", async () => {
  let cancelled = false;
  const response = {
    ok: false,
    status: 503,
    body: { cancel: async () => { cancelled = true; } },
  } as unknown as Response;

  await expect(exportConversation({
    conversationUrl,
    fetch: async () => response,
    stdout: () => undefined,
  })).rejects.toThrow("HTTP 503");
  expect(cancelled).toBe(true);
});

test("cancels a response reader after a partial body-read failure", async () => {
  let reads = 0;
  let cancelled = false;
  const output: string[] = [];
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads === 1) return { done: false, value: new TextEncoder().encode("partial") };
          throw new Error("partial body failed");
        },
        cancel: async () => { cancelled = true; },
      }),
    },
  } as unknown as Response;

  await expect(exportConversation({
    conversationUrl,
    fetch: async () => response,
    stdout: (text) => output.push(text),
  })).rejects.toThrow("partial body failed");
  expect(output).toEqual(["partial"]);
  expect(cancelled).toBe(true);
});

test("returns a nonzero exit and cancels when the byte sink fails", async () => {
  let cancelled = false;
  const stderr: string[] = [];
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array([0x7b]) }),
        cancel: async () => { cancelled = true; },
      }),
    },
  } as unknown as Response;

  const code = await runCli(["export", conversationUrl], {
    fetch: async () => response,
    stderr: (text) => stderr.push(text),
    stdout: () => undefined,
    stdoutBytes: async () => { throw new Error("output sink failed"); },
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });

  expect(code).toBe(1);
  expect(cancelled).toBe(true);
  expect(stderr).toEqual(["output sink failed\n"]);
});

test("dispatches export and advertises it in help", async () => {
  const help: string[] = [];
  const helpCode = await runCli(["--help"], {
    fetch: globalThis.fetch,
    stderr: () => undefined,
    stdout: (text) => help.push(text),
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });
  expect(helpCode).toBe(0);
  expect(help.join("")).toContain("Usage: msg export <conversation-url> [--format json|markdown]");

  const output: number[] = [];
  let requested = "";
  const code = await runCli(["export", conversationUrl, "--format", "markdown"], {
    fetch: async (input) => {
      requested = String(input);
      return new Response(new Uint8Array([0x23, 0x20, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74]));
    },
    stderr: () => undefined,
    stdout: () => { throw new Error("the byte sink should be selected"); },
    stdoutBytes: async (chunk) => { output.push(...chunk); },
    websocket: () => { throw new Error("WebSocket must not connect."); },
  });

  expect(code).toBe(0);
  expect(requested).toBe(`${conversationUrl}/export.md`);
  expect(new Uint8Array(output)).toEqual(new Uint8Array([0x23, 0x20, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74]));
});

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { readStdin, runCli } from "./cli.js";
import type { WaitSocket } from "./wait.js";
import { PersistentCookieJar } from "./cookie-jar.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const serviceOrigin = process.env.MSG_SERVICE_ORIGIN ?? "https://msg.0000.chat";
const cookieJar = new PersistentCookieJar({ serviceOrigin });
const code = await runCli(process.argv.slice(2), {
  fetch: cookieJar.wrapFetch(fetch),
  generatedClientMessageId: randomUUID,
  readStdin: (signal) => readStdin(process.stdin, signal),
  signal: controller.signal,
  serviceOrigin,
  sleep,
  stderr: (text) => process.stderr.write(text),
  stdinIsTTY: process.stdin.isTTY === true,
  stdout: (text) => process.stdout.write(text),
  websocket: (url) => new WebSocket(url, { headers: cookieJar.websocketHeaders(url) }) as unknown as WaitSocket,
});

process.exitCode = code;

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The msg post was interrupted."));
      return;
    }
    const timer = setTimeout(complete, delayMs);
    const interrupted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", interrupted);
      reject(new Error("The msg post was interrupted."));
    };
    function complete() {
      signal?.removeEventListener("abort", interrupted);
      resolve();
    }
    signal?.addEventListener("abort", interrupted, { once: true });
  });
}

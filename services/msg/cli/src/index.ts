#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { readStdin, runCli } from "./cli.js";
import type { WaitSocket } from "./wait.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

const code = await runCli(process.argv.slice(2), {
  fetch,
  generatedClientMessageId: randomUUID,
  readStdin: (signal) => readStdin(process.stdin, signal),
  signal: controller.signal,
  sleep,
  stderr: (text) => process.stderr.write(text),
  stdinIsTTY: process.stdin.isTTY === true,
  stdout: (text) => process.stdout.write(text),
  stdoutBytes: (chunk) => writeStdoutBytes(chunk, controller.signal),
  websocket: (url) => new WebSocket(url) as unknown as WaitSocket,
});

process.exitCode = code;

function writeStdoutBytes(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const cleanup = () => {
      process.stdout.removeListener("error", onError);
      process.stdout.removeListener("drain", onDrain);
      signal?.removeEventListener("abort", interrupted);
    };
    const finish = (error?: Error) => {
      if (settled || error === undefined && (!callbackDone || !drained)) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onDrain = () => {
      drained = true;
      finish();
    };
    const interrupted = () => {
      const error = new Error("The msg export was interrupted.");
      error.name = "AbortError";
      finish(error);
    };
    if (signal?.aborted) {
      interrupted();
      return;
    }
    signal?.addEventListener("abort", interrupted, { once: true });
    process.stdout.once("error", onError);
    try {
      drained = process.stdout.write(Buffer.from(chunk), (error?: Error | null) => {
        if (error) {
          finish(error);
          return;
        }
        callbackDone = true;
        finish();
      });
      if (!drained) process.stdout.once("drain", onDrain);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("stdout write failed"));
    }
  });
}

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

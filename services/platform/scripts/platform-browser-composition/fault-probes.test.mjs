import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

import { fetchBodyWithDeadline } from "./http.mjs";
import {
  acquireResourceWithShutdownCleanup,
  assertCloseCode,
  evaluateWithDeadline,
  processGroupExists,
  runBoundedCleanup,
  terminateProcessGroup,
} from "./lifecycle.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("stalled response body is bounded after headers", async () => {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "1" });
    response.flushHeaders();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      fetchBodyWithDeadline(`http://127.0.0.1:${port}/healthz`, undefined, {
        timeoutMs: 100,
      }),
    );
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("shutdown aborts an in-flight response body", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "1" });
    response.flushHeaders();
  });
  const port = await listen(server);
  const shutdownController = new AbortController();
  try {
    const startedAt = Date.now();
    const pending = fetchBodyWithDeadline(
      `http://127.0.0.1:${port}/healthz`,
      undefined,
      { shutdownSignal: shutdownController.signal, timeoutMs: 5000 },
    );
    setTimeout(() => shutdownController.abort(), 50);
    await assert.rejects(pending);
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("page evaluation is bounded independently of Playwright action timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    evaluateWithDeadline(
      { evaluate: () => new Promise(() => {}) },
      () => undefined,
      undefined,
      { label: "stalled_page_evaluate", timeoutMs: 100 },
    ),
    /stalled_page_evaluate_timeout/,
  );
  assert.ok(Date.now() - startedAt < 2000);
});

test("late acquired browser-like resource is closed after shutdown", async () => {
  const shuttingDown = true;
  let closeCount = 0;
  const resource = await acquireResourceWithShutdownCleanup(
    Promise.resolve({
      async close() {
        closeCount += 1;
      },
    }),
    {
      isShutdown: () => shuttingDown,
      dispose: (lateResource) => lateResource.close(),
      label: "late_browser_close",
      timeoutMs: 100,
    },
  );
  assert.equal(resource, null);
  assert.equal(closeCount, 1);
});

test("process-group cleanup handles an exited leader and kills descendants", async () => {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(leader, "spawn");
    await once(leader.stdout, "data");
    process.kill(leader.pid, "SIGTERM");
    await once(leader, "close");
    const result = await terminateProcessGroup(leader, {
      termTimeoutMs: 100,
      killTimeoutMs: 1000,
    });
    assert.equal(result.termSent, true);
    assert.equal(result.groupGone, true);
    assert.equal(processGroupExists(leader.pid), false);
  } finally {
    if (processGroupExists(leader.pid)) {
      try {
        process.kill(-leader.pid, "SIGKILL");
      } catch {}
    }
  }
});

test("process-group cleanup escalates from TERM to KILL", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.stdout.write('term\\n')); setInterval(() => {}, 1000);",
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(child, "spawn");
    child.stdout.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await runBoundedCleanup(
      "child_stop",
      () =>
        terminateProcessGroup(child, {
          termTimeoutMs: 100,
          killTimeoutMs: 1000,
        }),
      1500,
    );
    assert.equal(result.termSent, true);
    assert.equal(result.killSent, true);
    assert.equal(result.groupGone, true);
  } finally {
    if (processGroupExists(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
});

test("cleanup and close failures stay visible", async () => {
  await assert.rejects(
    runBoundedCleanup("synthetic_cleanup", () => new Promise(() => {}), 50),
    /synthetic_cleanup_failed/,
  );
  assert.throws(
    () => assertCloseCode({ closeSeen: false, closeCode: null }, 1008),
    /realtime_close_event_missing/,
  );
  assert.throws(
    () => assertCloseCode({ closeSeen: true, closeCode: 1000 }, 1008),
    /realtime_close_code_unexpected/,
  );
});

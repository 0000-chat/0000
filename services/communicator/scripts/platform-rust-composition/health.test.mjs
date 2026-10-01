import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { fetchWithDeadline } from "./health.mjs";

test("health deadline covers a response body that stalls after headers", async () => {
  const sockets = new Set();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "1" });
    response.flushHeaders();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const startedAt = Date.now();
    await assert.rejects(
      fetchWithDeadline(`http://127.0.0.1:${address.port}/healthz`, {
        timeoutMs: 100,
      }),
    );
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

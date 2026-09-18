import { request as sendWorkerRequest, createServer } from "node:http";
import { createInterface } from "node:readline";

import { Miniflare } from "miniflare";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let miniflare;
let dispatchServer;
let workerUrl;
let startupRequested = false;
let startupFailed = false;
let stopRequested = false;
let parentDisconnected = false;
let shutdownPromise;
let outboundRequests = [];
let outboundResponse = { status: 204, delayMs: 0 };

function send(message) {
  if (parentDisconnected) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(response, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
  response.end(body);
}

async function handleTestControl(request, response) {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/__test/outbound" && request.method === "GET") {
    sendJson(response, outboundRequests);
    return true;
  }
  if (path === "/__test/outbound" && request.method === "DELETE") {
    outboundRequests = [];
    response.writeHead(204);
    response.end();
    return true;
  }
  if (path === "/__test/outbound" && request.method === "POST") {
    let value;
    try { value = JSON.parse((await readBody(request)).toString("utf8")); } catch {
      response.writeHead(400);
      response.end();
      return true;
    }
    if (!isRecord(value) || !Number.isSafeInteger(value.status) || value.status < 200 || value.status > 599 || value.status === 204 && value.location !== undefined || value.location !== undefined && typeof value.location !== "string" || value.delay_ms !== undefined && (!Number.isSafeInteger(value.delay_ms) || value.delay_ms < 0 || value.delay_ms > 10_000)) {
      response.writeHead(400);
      response.end();
      return true;
    }
    outboundResponse = { status: value.status, delayMs: typeof value.delay_ms === "number" ? value.delay_ms : 0, ...(typeof value.location === "string" ? { location: value.location } : {}) };
    response.writeHead(204);
    response.end();
    return true;
  }
  if (path === "/__test/alarm" && request.method === "POST") {
    let value;
    try { value = JSON.parse((await readBody(request)).toString("utf8")); } catch {
      response.writeHead(400);
      response.end();
      return true;
    }
    if (!isRecord(value) || typeof value.room !== "string" || !value.room || value.room.length > 512 || !miniflare) {
      response.writeHead(400);
      response.end();
      return true;
    }
    const namespace = await miniflare.getDurableObjectNamespace("ConversationRoom");
    const stub = namespace.get(namespace.idFromName(value.room));
    const result = await stub.fetch("https://room/__test/run-alarm", { method: "POST" });
    const body = Buffer.from(await result.arrayBuffer());
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
    response.end(body);
    return true;
  }
  if (path === "/__test/push-send-gate" && request.method === "POST") {
    let value;
    try { value = JSON.parse((await readBody(request)).toString("utf8")); } catch {
      response.writeHead(400);
      response.end();
      return true;
    }
    if (!isRecord(value) || typeof value.room !== "string" || !value.room || value.room.length > 512 || !["arm", "wait", "release"].includes(value.action) || !miniflare) {
      response.writeHead(400);
      response.end();
      return true;
    }
    const namespace = await miniflare.getDurableObjectNamespace("ConversationRoom");
    const stub = namespace.get(namespace.idFromName(value.room));
    const result = await stub.fetch("https://room/__test/push-send-gate", {
      body: JSON.stringify({ action: value.action }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = Buffer.from(await result.arrayBuffer());
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
    response.end(body);
    return true;
  }
  if (path === "/__test/mark-webhook-sending" && request.method === "POST") {
    let value;
    try { value = JSON.parse((await readBody(request)).toString("utf8")); } catch {
      response.writeHead(400);
      response.end();
      return true;
    }
    if (!isRecord(value) || typeof value.room !== "string" || !value.room || value.room.length > 512 || typeof value.event_id !== "string" || !value.event_id || value.event_id.length > 128 || !miniflare) {
      response.writeHead(400);
      response.end();
      return true;
    }
    const namespace = await miniflare.getDurableObjectNamespace("ConversationRoom");
    const stub = namespace.get(namespace.idFromName(value.room));
    const result = await stub.fetch("https://room/__test/mark-webhook-sending", {
      body: JSON.stringify({ event_id: value.event_id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = Buffer.from(await result.arrayBuffer());
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
    response.end(body);
    return true;
  }
  if (path === "/__test/delete-webhook-source" && request.method === "POST") {
    let value;
    try { value = JSON.parse((await readBody(request)).toString("utf8")); } catch {
      response.writeHead(400);
      response.end();
      return true;
    }
    if (!isRecord(value) || typeof value.room !== "string" || !value.room || value.room.length > 512 || typeof value.message_id !== "string" || !value.message_id || value.message_id.length > 128 || !miniflare) {
      response.writeHead(400);
      response.end();
      return true;
    }
    const namespace = await miniflare.getDurableObjectNamespace("ConversationRoom");
    const stub = namespace.get(namespace.idFromName(value.room));
    const result = await stub.fetch("https://room/__test/delete-webhook-source", {
      body: JSON.stringify({ message_id: value.message_id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = Buffer.from(await result.arrayBuffer());
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
    response.end(body);
    return true;
  }
  return false;
}

function parseDescriptor(encoded) {
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.method !== "string" || !Array.isArray(value.headers) || typeof value.hasBody !== "boolean") {
    throw new Error("Invalid Miniflare test dispatch request.");
  }
  const headers = value.headers;
  if (!headers.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")) {
    throw new Error("Invalid Miniflare test dispatch headers.");
  }
  const url = new URL(value.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid Miniflare test dispatch URL.");
  return { url, method: value.method, headers, hasBody: value.hasBody };
}

function dispatchOverHttp(descriptor, body) {
  if (!workerUrl) throw new Error("Node-owned Miniflare is not ready.");
  const headers = Object.fromEntries(descriptor.headers.map(([name, value]) => [name.toLowerCase(), value]));
  delete headers.host;
  delete headers.connection;
  delete headers["transfer-encoding"];

  // Miniflare uses this bridge header to preserve the URL supplied to dispatchFetch.
  headers["mf-original-url"] = descriptor.url.toString();
  headers["mf-disable-pretty-error"] = "true";
  if (descriptor.hasBody) {
    if (headers["content-length"] === "0") delete headers["content-length"];
    if (headers["content-length"] === undefined) headers["content-length"] = String(body.byteLength);
  }

  return new Promise((resolve, reject) => {
    const outgoing = sendWorkerRequest({
      hostname: workerUrl.hostname,
      port: workerUrl.port,
      path: `${descriptor.url.pathname}${descriptor.url.search}`,
      method: descriptor.method,
      headers,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("error", reject);
      incoming.on("end", () => resolve({
        status: incoming.statusCode ?? 502,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      }));
    });
    outgoing.on("error", reject);
    if (descriptor.hasBody) outgoing.end(body);
    else outgoing.end();
  });
}

function respondWithError(response, error) {
  const body = Buffer.from(JSON.stringify({ error: errorMessage(error) }));
  response.writeHead(502, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "x-msg-test-runtime-error": "1",
  });
  response.end(body);
}

async function dispatch(request, response) {
  if (await handleTestControl(request, response)) return;
  if (request.method !== "POST" || request.url !== "/dispatch") {
    response.writeHead(404);
    response.end();
    return;
  }

  const encodedRequest = request.headers["x-msg-test-request"];
  if (typeof encodedRequest !== "string") {
    response.writeHead(400);
    response.end();
    return;
  }

  try {
    const descriptor = parseDescriptor(encodedRequest);
    const body = await readBody(request);
    const workerResponse = await dispatchOverHttp(descriptor, body);
    const headers = {};
    for (const [name, value] of Object.entries(workerResponse.headers)) {
      if (value === undefined || ["connection", "content-length", "keep-alive", "transfer-encoding", "upgrade"].includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    response.writeHead(workerResponse.status, headers);
    response.end(workerResponse.body);
  } catch (error) {
    respondWithError(response, error);
  }
}

async function start(configuration) {
  try {
    miniflare = new Miniflare({
      bindings: configuration.bindings,
      compatibilityDate: configuration.compatibilityDate,
      durableObjects: configuration.durableObjects,
      durableObjectsPersist: configuration.persistenceDirectory,
      host: "127.0.0.1",
      modules: true,
      outboundService: async (request) => {
        const bodyBytes = Buffer.from(await request.arrayBuffer());
        const responseConfig = outboundResponse;
        const captured = {
          body: bodyBytes.toString("utf8"),
          body_base64: bodyBytes.toString("base64"),
          headers: Object.fromEntries(request.headers.entries()),
          method: request.method,
          url: request.url,
        };
        outboundRequests.push(captured);
        if (responseConfig.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseConfig.delayMs));
        const responseBody = responseConfig.status === 204 || responseConfig.status === 304 ? null : new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("test-only response body"));
          },
        });
        return new Response(responseBody, {
          status: responseConfig.status,
          ...(responseConfig.location === undefined ? {} : { headers: { location: responseConfig.location } }),
        });
      },
      script: configuration.script,
    });
    dispatchServer = createServer((request, response) => {
      void dispatch(request, response);
    });
    const [readyUrl, address] = await Promise.all([miniflare.ready, listen(dispatchServer)]);
    workerUrl = readyUrl;
    if (stopRequested) return;
    send({
      type: "ready",
      workerUrl: readyUrl.toString(),
      dispatchUrl: `http://127.0.0.1:${address.port}/dispatch`,
    });
  } catch (error) {
    if (shutdownPromise) return;
    startupFailed = true;
    try {
      if (dispatchServer?.listening) await close(dispatchServer);
      await miniflare?.dispose();
    } catch {
      // Preserve the startup error.
    }
    send({ type: "error", message: errorMessage(error) });
    process.exitCode = 1;
    input.close();
    process.stdin.destroy();
  }
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopRequested = true;
  shutdownPromise = (async () => {
    try {
      if (dispatchServer?.listening) await close(dispatchServer);
      await miniflare?.dispose();
      process.exitCode = 0;
    } catch (error) {
      send({ type: "error", message: errorMessage(error) });
      process.exitCode = 1;
    } finally {
      input.close();
      process.stdin.destroy();
    }
  })();
  return shutdownPromise;
}

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
    process.exitCode = 1;
    void shutdown();
    return;
  }

  if (isRecord(message) && message.type === "start" && !startupRequested && isRecord(message.configuration)) {
    startupRequested = true;
    void start(message.configuration);
  } else if (isRecord(message) && message.type === "stop") {
    void shutdown();
  }
});

input.on("close", () => {
  if (stopRequested || startupFailed) return;
  parentDisconnected = true;
  void shutdown();
});

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

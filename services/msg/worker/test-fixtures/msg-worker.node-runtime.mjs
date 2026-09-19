import { request as sendWorkerRequest, createServer } from "node:http";
import { readFile } from "node:fs/promises";
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
      ...(configuration.d1Databases ? { d1Databases: configuration.d1Databases } : {}),
      ...(configuration.d1Persist ? { d1Persist: configuration.d1Persist } : {}),
      durableObjectsPersist: configuration.persistenceDirectory,
      host: "127.0.0.1",
      modules: true,
      ratelimits: configuration.ratelimits,
      script: configuration.script,
    });
    if (configuration.d1MigrationPaths?.length) {
      const database = await miniflare.getD1Database("MSG_DB");
      for (const path of configuration.d1MigrationPaths) {
        const source = await readFile(path, "utf8");
        for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
          try {
            await database.prepare(statement).run();
          } catch (error) {
            if (!(error instanceof Error) || !/duplicate column name|already exists/iu.test(error.message)) throw error;
          }
        }
      }
    }
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

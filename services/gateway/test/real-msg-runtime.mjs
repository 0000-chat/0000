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
const keepAlive = setInterval(() => {}, 1_000);
const standaloneConfigurationPath = process.argv[2] ?? "";

function send(message) {
  if (parentDisconnected) return;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseDescriptor(value) {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const descriptor = JSON.parse(decoded);
  if (
    !isRecord(descriptor) ||
    typeof descriptor.url !== "string" ||
    typeof descriptor.method !== "string" ||
    !Array.isArray(descriptor.headers) ||
    typeof descriptor.hasBody !== "boolean"
  ) {
    throw new Error("Invalid real Msg test dispatch request.");
  }
  const url = new URL(descriptor.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid real Msg test dispatch URL.");
  }
  if (
    !descriptor.headers.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  ) {
    throw new Error("Invalid real Msg test dispatch headers.");
  }
  return {
    url,
    method: descriptor.method,
    headers: descriptor.headers,
    hasBody: descriptor.hasBody,
  };
}

function dispatchOverHttp(descriptor, body) {
  if (!workerUrl) throw new Error("Real Msg Worker is not ready.");
  const headers = Object.fromEntries(
    descriptor.headers.map(([name, value]) => [name.toLowerCase(), value]),
  );
  delete headers.host;
  delete headers.connection;
  delete headers["transfer-encoding"];
  headers.host = descriptor.url.host;

  // Miniflare's HTTP bridge uses this header to preserve the public origin.
  headers["mf-original-url"] = descriptor.url.toString();
  headers["mf-disable-pretty-error"] = "true";
  if (descriptor.hasBody) {
    if (headers["content-length"] === "0") delete headers["content-length"];
    if (headers["content-length"] === undefined)
      headers["content-length"] = String(body.byteLength);
  }

  return new Promise((resolve, reject) => {
    const outgoing = sendWorkerRequest(
      {
        hostname: workerUrl.hostname,
        port: workerUrl.port,
        path: `${descriptor.url.pathname}${descriptor.url.search}`,
        method: descriptor.method,
        headers,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 502,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (descriptor.hasBody) outgoing.end(body);
    else outgoing.end();
  });
}

async function dispatch(request, response) {
  if (request.method !== "POST" || request.url !== "/dispatch") {
    response.writeHead(404);
    response.end();
    return;
  }
  const encodedRequest = request.headers["x-real-msg-test-request"];
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
      if (
        value === undefined ||
        [
          "connection",
          "content-length",
          "keep-alive",
          "transfer-encoding",
          "upgrade",
        ].includes(name.toLowerCase())
      )
        continue;
      headers[name] = value;
    }
    response.writeHead(workerResponse.status, headers);
    response.end(workerResponse.body);
  } catch (error) {
    const body = Buffer.from(JSON.stringify({ error: errorMessage(error) }));
    response.writeHead(502, {
      "content-type": "application/json; charset=utf-8",
      "content-length": body.byteLength,
      "x-real-msg-test-runtime-error": "1",
    });
    response.end(body);
  }
}

async function applyMigrations(database, migrations) {
  for (const migration of migrations) {
    if (typeof migration !== "string")
      throw new Error("Invalid Msg migration.");
    for (const statement of migration
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
}

async function start(configurationPath) {
  try {
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    if (
      !isRecord(configuration) ||
      !isRecord(configuration.bindings) ||
      typeof configuration.compatibilityDate !== "string" ||
      !isRecord(configuration.durableObjects) ||
      typeof configuration.persistenceDirectory !== "string" ||
      typeof configuration.d1PersistenceDirectory !== "string" ||
      typeof configuration.gatewayD1PersistenceDirectory !== "string" ||
      typeof configuration.gatewayScript !== "string" ||
      typeof configuration.gatewayScriptPath !== "string" ||
      !Array.isArray(configuration.gatewayMigrations) ||
      !Array.isArray(configuration.gatewaySetup) ||
      typeof configuration.script !== "string" ||
      typeof configuration.scriptPath !== "string" ||
      !Array.isArray(configuration.migrations)
    ) {
      throw new Error("Invalid real Msg Worker startup configuration.");
    }
    miniflare = new Miniflare({
      host: "127.0.0.1",
      workers: [
        {
          compatibilityDate: configuration.compatibilityDate,
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["GATEWAY_DB"],
          d1Persist: configuration.gatewayD1PersistenceDirectory,
          modulesRoot: "/",
          modules: true,
          name: "gateway",
          script: configuration.gatewayScript,
          scriptPath: configuration.gatewayScriptPath,
          serviceBindings: { MSG: "msg" },
        },
        {
          bindings: configuration.bindings,
          compatibilityDate: configuration.compatibilityDate,
          d1Databases: ["MSG_DB"],
          d1Persist: configuration.d1PersistenceDirectory,
          durableObjects: configuration.durableObjects,
          durableObjectsPersist: configuration.persistenceDirectory,
          modules: true,
          modulesRoot: "/",
          name: "msg",
          script: configuration.script,
          scriptPath: configuration.scriptPath,
        },
      ],
    });
    const readyUrl = await miniflare.ready;
    const gatewayDatabase = await miniflare.getD1Database(
      "GATEWAY_DB",
      "gateway",
    );
    const msgDatabase = await miniflare.getD1Database("MSG_DB", "msg");
    await applyMigrations(gatewayDatabase, configuration.gatewayMigrations);
    await applyMigrations(msgDatabase, configuration.migrations);
    await applyMigrations(gatewayDatabase, configuration.gatewaySetup);
    workerUrl = new URL(readyUrl);
    dispatchServer = createServer((request, response) => {
      void dispatch(request, response);
    });
    const address = await listen(dispatchServer);
    if (stopRequested) return;
    send({
      type: "ready",
      workerUrl: workerUrl.toString(),
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
    clearInterval(keepAlive);
    input.close();
    process.stdin.destroy();
  }
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopRequested = true;
  shutdownPromise = (async () => {
    try {
      clearInterval(keepAlive);
      dispatchServer?.closeAllConnections?.();
      dispatchServer?.unref?.();
      if (dispatchServer?.listening) {
        await Promise.race([
          close(dispatchServer),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
      }
      await miniflare?.dispose();
      process.exitCode = 0;
    } catch (error) {
      send({ type: "error", message: errorMessage(error) });
      process.exitCode = 1;
    } finally {
      clearInterval(keepAlive);
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
  if (isRecord(message) && message.type === "start" && !startupRequested) {
    startupRequested = true;
    void start(
      typeof message.configurationPath === "string"
        ? message.configurationPath
        : "",
    );
  } else if (isRecord(message) && message.type === "stop") {
    void shutdown();
  }
});

input.on("close", () => {
  if (standaloneConfigurationPath) return;
  if (stopRequested || startupFailed) return;
  parentDisconnected = true;
  void shutdown();
});

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

if (standaloneConfigurationPath) {
  startupRequested = true;
  void start(standaloneConfigurationPath);
}

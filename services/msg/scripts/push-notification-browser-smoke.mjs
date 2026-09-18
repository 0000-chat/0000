import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { PUSH_SERVICE_WORKER_PATH, pushServiceWorkerResponse } from "../worker/src/push-service-worker.ts";

const notificationTitle = "New message in msg";
const timeoutMs = 15_000;

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Chromium DevTools WebSocket timed out"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Chromium DevTools WebSocket did not open"));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chromium DevTools command timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Chromium DevTools connection closed"));
    }
    this.pending.clear();
  }
}

assert(process.env.DBUS_SESSION_BUS_ADDRESS, "run this command through dbus-run-session");

const chromiumPath = resolveChromiumPath();
const runDirectory = mkdtempSync(join(tmpdir(), "msg-push-browser-smoke-"));
const roomPath = "/" + randomBytes(32).toString("base64url");
const roomId = randomUUID();
const roomUrl = new URL(roomPath + "?view=agent", "http://127.0.0.1");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname === PUSH_SERVICE_WORKER_PATH) {
      return pushServiceWorkerResponse();
    }
    if (request.method === "GET" && (pathname === "/" || pathname === roomPath)) {
      return new Response("<!doctype html><title>msg notification smoke</title>", {
        headers: { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});
roomUrl.port = String(server.port);
const origin = roomUrl.origin;
const exactRoomUrl = roomUrl.href;

let xvfb;
let bridge;
let chromium;
let cdp;

try {
  const display = await startXvfb();
  bridge = startNotificationBridge(origin, roomPath);
  await bridge.ready;

  const profile = join(runDirectory, "chromium-profile");
  chromium = spawn(chromiumPath, [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--user-data-dir=" + profile,
  ], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });

  const devtoolsPort = await waitForDevtoolsPort(profile, chromium);
  const versionResponse = await fetch("http://127.0.0.1:" + devtoolsPort + "/json/version");
  assert(versionResponse.ok, "Chromium DevTools endpoint did not respond");
  const version = await versionResponse.json();
  assert(typeof version.webSocketDebuggerUrl === "string", "Chromium DevTools WebSocket is missing");
  cdp = await CdpConnection.connect(version.webSocketDebuggerUrl);

  await cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "granted",
    origin,
  });

  let registrationId;
  cdp.on("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const registration of event.registrations ?? []) {
      if (registration.scopeURL === origin + "/" && !registration.isDeleted) {
        registrationId = registration.registrationId;
      }
    }
  });
  const roomTab = await createPage(cdp, exactRoomUrl);
  await cdp.send("ServiceWorker.enable", {}, roomTab.sessionId);
  await waitFor(async () => {
    const page = await evaluate(cdp, roomTab.sessionId, "({ href: location.href, state: document.readyState })");
    return page.href === exactRoomUrl && page.state === "complete" ? page : undefined;
  }, "room page did not load before service worker registration");
  const registration = await waitFor(async () => {
    const result = await evaluate(cdp, roomTab.sessionId, [
      "(async () => {",
      "  const registration = await navigator.serviceWorker.register(" + JSON.stringify(PUSH_SERVICE_WORKER_PATH) + ", { scope: '/' });",
      "  await navigator.serviceWorker.ready;",
      "  return { scope: registration.scope, script: registration.active && registration.active.scriptURL };",
      "})()",
    ].join("\n"));
    if (!result || result.scope !== origin + "/" || result.script !== origin + PUSH_SERVICE_WORKER_PATH) return undefined;
    return result;
  }, "the production service worker did not activate");
  assert(registration.scope === origin + "/", "service worker did not claim the root scope");
  const activeRegistrationId = await waitFor(() => registrationId, "Chromium did not report the service worker registration");

  await cdp.send("Target.closeTarget", { targetId: roomTab.targetId });
  await waitFor(async () => {
    const targets = await getTargets(cdp);
    return targets.every((target) => !isRoomTarget(target, origin, roomPath));
  }, "the room tab did not close");
  assertNoRoomTargets(await getTargets(cdp), origin, roomPath);

  const homeTab = await createPage(cdp, origin + "/");
  await cdp.send("ServiceWorker.enable", {}, homeTab.sessionId);
  await deliverPush(cdp, homeTab.sessionId, origin, activeRegistrationId, roomId, exactRoomUrl);
  const firstNativeNotification = await bridge.waitForNotification(0);
  assert(firstNativeNotification.title === notificationTitle, "native notification title was not generic");

  const visible = await waitFor(async () => {
    const value = await evaluate(cdp, homeTab.sessionId, [
      "(async () => {",
      "  const registration = await navigator.serviceWorker.ready;",
      "  const notifications = await registration.getNotifications();",
      "  return notifications.map((notification) => ({",
      "    title: notification.title,",
      "    body: notification.body,",
      "    tag: notification.tag,",
      "    room_url: notification.data && notification.data.room_url",
      "  }));",
      "})()",
    ].join("\n"));
    return Array.isArray(value) && value.length > 0 ? value : undefined;
  }, "Chromium did not retain the service worker notification");
  assert(visible.length === 1, "expected exactly one visible notification");
  assert(visible[0].title === notificationTitle, "browser notification title was not generic");
  assert(visible[0].body === "", "browser notification included a message preview");
  assert(visible[0].tag === "msg-room-" + roomId, "browser notification did not use the room collapse tag");
  assert(visible[0].room_url === exactRoomUrl, "browser notification did not retain the room destination");
  assertNoRoomTargets(await getTargets(cdp), origin, roomPath);

  bridge.click(firstNativeNotification.id);
  const openedRoom = await waitFor(async () => {
    const targets = await getTargets(cdp);
    return targets.find((target) => target.type === "page" && target.url === exactRoomUrl);
  }, "native notification activation did not open the room");
  assert(openedRoom, "notification click did not open the requested room");

  process.stdout.write("msg browser notification smoke passed: closed-room push, generic preview-free alert, and native click-through\n");
  process.stdout.write("delivery used Chromium CDP ServiceWorker.deliverPushMessage; no push provider or signed/encrypted provider delivery was tested\n");
  process.stdout.write("click used the isolated freedesktop notification ActionInvoked bridge; it was not a physical desktop click\n");
  if (!firstNativeNotification.bodyEmpty) {
    process.stdout.write("desktop body metadata: origin=" + firstNativeNotification.bodyMatchesOrigin
      + ", contains_origin=" + firstNativeNotification.bodyContainsOrigin
      + ", app_name=" + firstNativeNotification.bodyMatchesAppName
      + ", summary=" + firstNativeNotification.bodyMatchesSummary
      + ", page_title=" + firstNativeNotification.bodyMatchesPageTitle
      + ", contains_room_path=" + firstNativeNotification.bodyContainsRoomPath
      + ", invisible=" + firstNativeNotification.bodyInvisible
      + ", other=" + firstNativeNotification.bodyIsOther + "\n");
  }
} finally {
  cdp?.close();
  await stopProcess(chromium);
  await stopProcess(bridge?.child);
  await stopProcess(xvfb);
  server.stop(true);
  rmSync(runDirectory, { recursive: true, force: true });
}

async function createPage(connection, url) {
  const { targetId } = await connection.send("Target.createTarget", { url, newWindow: true });
  return await attachPage(connection, targetId);
}

async function attachPage(connection, targetId) {
  const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
  await connection.send("Page.enable", {}, attached.sessionId);
  await connection.send("Runtime.enable", {}, attached.sessionId);
  return { targetId, sessionId: attached.sessionId };
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "unknown browser exception";
    const safeDetail = String(detail)
      .split(exactRoomUrl).join("[room URL]")
      .split(roomPath).join("[room path]")
      .split(origin).join("[test origin]");
    throw new Error("Chromium evaluation failed: " + safeDetail);
  }
  return result.result?.value;
}

async function getTargets(connection) {
  const result = await connection.send("Target.getTargets");
  return result.targetInfos;
}

function isRoomTarget(target, expectedOrigin, expectedPath) {
  if (target.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return url.origin === expectedOrigin && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

function assertNoRoomTargets(targets, expectedOrigin, expectedPath) {
  assert(!targets.some((target) => isRoomTarget(target, expectedOrigin, expectedPath)), "a room tab was open at the push boundary");
}

function resolveChromiumPath() {
  const override = process.env.MSG_CHROME_BIN;
  if (override) {
    assert(isExecutable(override), "MSG_CHROME_BIN must point to an executable Chromium binary");
    return override;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  throw new Error("Chromium is missing; set MSG_CHROME_BIN to a Chromium executable");
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function deliverPush(connection, sessionId, expectedOrigin, serviceWorkerRegistrationId, expectedRoomId, destination) {
  await connection.send("ServiceWorker.deliverPushMessage", {
    origin: expectedOrigin,
    registrationId: serviceWorkerRegistrationId,
    data: JSON.stringify({ type: "message.created", room_id: expectedRoomId, room_url: destination }),
  }, sessionId);
}

async function waitForDevtoolsPort(profile, process) {
  const portFile = join(profile, "DevToolsActivePort");
  return await waitFor(() => {
    if (process.exitCode !== null) throw new Error("Chromium exited before DevTools started");
    if (!existsSync(portFile)) return undefined;
    const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  }, "Chromium DevTools did not start");
}

async function startXvfb() {
  const process = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1024x768x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  xvfb = process;
  let output = "";
  const display = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Xvfb did not start")), timeoutMs);
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/(?:^|\n)(\d+)(?:\n|$)/u);
      if (!match) return;
      clearTimeout(timeout);
      resolve(":" + match[1]);
    });
    process.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error("Xvfb could not start: " + error.message));
    });
    process.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Xvfb exited before starting"));
    });
  });
  return display;
}

function startNotificationBridge(expectedOrigin, expectedRoomPath) {
  const environment = {
    ...process.env,
    MSG_SMOKE_ORIGIN: expectedOrigin,
    MSG_SMOKE_ROOM_PATH: expectedRoomPath,
  };
  const child = spawn(process.env.MSG_PYTHON_BIN ?? "python3", [
    "-u",
    new URL("./notification-smoke-dbus.py", import.meta.url).pathname,
  ], { env: environment, stdio: ["pipe", "pipe", "ignore"] });
  let output = "";
  const notifications = [];
  const waiters = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    let readyTimeout;
    resolveReady = () => {
      clearTimeout(readyTimeout);
      resolve();
    };
    rejectReady = (error) => {
      clearTimeout(readyTimeout);
      reject(error);
    };
    readyTimeout = setTimeout(() => rejectReady(new Error("Python D-Bus notification bridge timed out")), timeoutMs);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    const lines = output.split("\n");
    output = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "ready") resolveReady();
      if (event.type === "notification") {
        notifications.push(event);
        for (const waiter of [...waiters]) {
          if (notifications.length <= waiter.after) continue;
          clearTimeout(waiter.timeout);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(notifications[waiter.after]);
        }
      }
    }
  });
  child.once("error", () => rejectReady(new Error("Python D-Bus notification bridge could not start")));
  child.once("exit", (code) => {
    if (code !== 0) rejectReady(new Error("Python D-Bus notification bridge exited"));
  });
  return {
    child,
    notifications,
    ready,
    waitForNotification(after) {
      if (notifications.length > after) return Promise.resolve(notifications[after]);
      return new Promise((resolve, reject) => {
        const waiter = { after, resolve, reject, timeout: undefined };
        waiter.timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("Chromium did not display a native notification"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    click(id) {
      child.stdin.write("click " + id + "\n");
    },
  };
}

async function waitFor(read, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined && result !== null && result !== false) return result;
    await delay(100);
  }
  throw new Error("push browser smoke failed: " + message);
}

async function stopProcess(process) {
  if (!process || process.pid === undefined || process.exitCode !== null || process.signalCode !== null) return;
  await new Promise((resolve) => {
    let lastResort;
    const finish = () => {
      clearTimeout(forceKill);
      clearTimeout(lastResort);
      resolve();
    };
    const forceKill = setTimeout(() => {
      if (!process.kill("SIGKILL")) {
        finish();
        return;
      }
      lastResort = setTimeout(finish, 1_000);
    }, 3_000);
    process.once("exit", finish);
    process.once("error", finish);
    if (process.exitCode !== null || process.signalCode !== null || !process.kill("SIGTERM")) finish();
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error("push browser smoke failed: " + message);
}

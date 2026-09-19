import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { PersistentCookieJar } from "./cookie-jar";

async function temporaryJar(): Promise<{ jar: PersistentCookieJar; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "msg-cookie-jar-"));
  const filePath = join(directory, "cookies.json");
  return { filePath, jar: new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" }) };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("stores host and path scoped cookies without forwarding room credentials", async () => {
  const { jar } = await temporaryJar();
  const response = new Response(null, { headers: [
    ["set-cookie", "msg_guest_control=control; Path=/; HttpOnly; Secure; SameSite=Lax"],
    ["set-cookie", "msg_resource=room-one; Path=/room-one; HttpOnly; Secure; SameSite=Lax"],
    ["set-cookie", "msg_management=manage; Path=/manage/room-one; HttpOnly; Secure; SameSite=Lax"],
  ] });
  jar.store("https://msg.0000.chat/room-one", response);

  expect(jar.cookieHeader("https://msg.0000.chat/room-one")).toContain("msg_guest_control=control");
  expect(jar.cookieHeader("wss://msg.0000.chat/room-one/live")).toContain("msg_guest_control=control");
  expect(jar.websocketHeaders("wss://msg.0000.chat/room-one/live").Cookie).toContain("msg_resource=room-one");
  expect(jar.cookieHeader("https://msg.0000.chat/room-one")).toContain("msg_resource=room-one");
  expect(jar.cookieHeader("https://msg.0000.chat/room-two")).toBe("msg_guest_control=control");
  expect(jar.cookieHeader("https://msg.0000.chat/manage/room-one")).toContain("msg_management=manage");
  expect(jar.cookieHeader("https://foreign.0000.chat/room-one")).toBeUndefined();
});

test("persists private cookie state and honors Secure transport", async () => {
  const { jar, filePath } = await temporaryJar();
  jar.store("https://msg.0000.chat/room-one", new Response(null, { headers: { "set-cookie": "msg_resource=encoded%20value; Path=/room-one; Secure" } }));
  expect(jar.cookieHeader("http://msg.0000.chat/room-one")).toBeUndefined();
  expect(jar.cookieHeader("https://msg.0000.chat/room-one")).toBe("msg_resource=encoded%20value");
  const mode = (await stat(filePath)).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(await readFile(filePath, "utf8")).toContain("msg_resource");
});

test("rejects cross origin redirects while wrapping fetch", async () => {
  const { jar } = await temporaryJar();
  const fetcher = jar.wrapFetch(async () => new Response(null, { status: 302, headers: { location: "https://foreign.example/room" } }));
  await expect(fetcher("https://msg.0000.chat/room-one")).rejects.toThrow("unexpected cross-origin redirect");
});

test("reloads and merges cookie state before atomic replacement", async () => {
  const { filePath } = await temporaryJar();
  const first = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  const second = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  await Promise.all([
    Promise.resolve().then(() => first.store("https://msg.0000.chat/room-one", new Response(null, { headers: { "set-cookie": "msg_guest_control=control; Path=/; Secure" } }))),
    Promise.resolve().then(() => second.store("https://msg.0000.chat/room-one", new Response(null, { headers: { "set-cookie": "msg_resource=room-one; Path=/room-one; Secure" } }))),
  ]);
  const reloaded = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  expect(reloaded.cookieHeader("https://msg.0000.chat/room-one")).toContain("msg_guest_control=control");
  expect(reloaded.cookieHeader("https://msg.0000.chat/room-one")).toContain("msg_resource=room-one");
});

test("merges concurrent cookie writers from separate CLI processes", async () => {
  const { filePath } = await temporaryJar();
  const moduleUrl = new URL("./cookie-jar.ts", import.meta.url).href;
  const writers = Array.from({ length: 8 }, (_, index) => {
    const cookie = `msg_worker_${index}=worker-${index}; Path=/room-overlap; Secure`;
    const source = `import { PersistentCookieJar } from ${JSON.stringify(moduleUrl)}; const jar = new PersistentCookieJar({ filePath: process.env.T09_COOKIE_JAR, serviceOrigin: "https://msg.0000.chat" }); jar.store("https://msg.0000.chat/room-overlap", new Response(null, { headers: { "set-cookie": ${JSON.stringify(cookie)} } }));`;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", source], { env: { ...process.env, T09_COOKIE_JAR: filePath }, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Cookie writer exited ${code}: ${error}`)));
    });
  });
  await Promise.all(writers);
  const merged = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" }).cookieHeader("https://msg.0000.chat/room-overlap") ?? "";
  for (let index = 0; index < 8; index += 1) expect(merged).toContain(`msg_worker_${index}=worker-${index}`);
});

test("serializes separate-process first-use bootstrap across request and response", async () => {
  const { filePath } = await temporaryJar();
  const moduleUrl = new URL("./cookie-jar.ts", import.meta.url).href;
  const requests = Array.from({ length: 2 }, (_, index) => {
    const room = `room-first-use-${index}`;
    const source = `
      import { PersistentCookieJar } from ${JSON.stringify(moduleUrl)};
      const jar = new PersistentCookieJar({ filePath: process.env.T09_COOKIE_JAR, serviceOrigin: "https://msg.0000.chat" });
      const fetcher = jar.wrapFetch(async (_input, init) => {
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        const control = cookie.split("; ").find((value) => value.startsWith("msg_guest_control="))?.slice("msg_guest_control=".length) ?? ${JSON.stringify(`guest-${index}`)};
        await new Promise((resolve) => setTimeout(resolve, 150));
        return new Response(null, { headers: [
          ["set-cookie", "msg_guest_control=" + control + "; Path=/; Secure"],
          ["set-cookie", "msg_resource=" + control + "; Path=/${room}; Secure"],
        ] });
      });
      await fetcher(${JSON.stringify(`https://msg.0000.chat/${room}`)});
    `;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", source], {
        env: { ...process.env, T09_COOKIE_JAR: filePath },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let error = "";
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`First-use process exited ${code}: ${error}`)));
    });
  });
  await Promise.all(requests);

  const jar = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  const control = jar.cookieHeader("https://msg.0000.chat/room-first-use-0")?.match(/(?:^|; )msg_guest_control=([^;]+)/u)?.[1];
  const firstResource = jar.cookieHeader("https://msg.0000.chat/room-first-use-0")?.match(/(?:^|; )msg_resource=([^;]+)/u)?.[1];
  const secondResource = jar.cookieHeader("https://msg.0000.chat/room-first-use-1")?.match(/(?:^|; )msg_resource=([^;]+)/u)?.[1];
  expect(control).toBeString();
  expect(firstResource).toBe(control);
  expect(secondResource).toBe(control);
});

test("does not steal a live owner whose lock looks stale during delayed first use", async () => {
  const { filePath } = await temporaryJar();
  const readyPath = `${filePath}.ready`;
  const moduleUrl = new URL("./cookie-jar.ts", import.meta.url).href;
  const ownerSource = `
    import { utimesSync, writeFileSync } from "node:fs";
    import { PersistentCookieJar } from ${JSON.stringify(moduleUrl)};
    const filePath = process.env.T09_COOKIE_JAR;
    const jar = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
    const fetcher = jar.wrapFetch(async (_input, init) => {
      utimesSync(filePath + ".lock", new Date(0), new Date(0));
      writeFileSync(process.env.T09_COOKIE_READY, "ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      const control = cookie.split("; ").find((value) => value.startsWith("msg_guest_control="))?.slice("msg_guest_control=".length) ?? "guest-owner";
      return new Response(null, { headers: [
        ["set-cookie", "msg_guest_control=" + control + "; Path=/; Secure"],
        ["set-cookie", "msg_resource=" + control + "; Path=/room-delayed-owner; Secure"],
      ] });
    });
    await fetcher("https://msg.0000.chat/room-delayed-owner");
  `;
  const followerSource = `
    import { writeFileSync } from "node:fs";
    import { PersistentCookieJar } from ${JSON.stringify(moduleUrl)};
    const jar = new PersistentCookieJar({ filePath: process.env.T09_COOKIE_JAR, serviceOrigin: "https://msg.0000.chat" });
    const fetcher = jar.wrapFetch(async (_input, init) => {
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      const control = cookie.split("; ").find((value) => value.startsWith("msg_guest_control="))?.slice("msg_guest_control=".length) ?? "guest-follower";
      return new Response(null, { headers: [
        ["set-cookie", "msg_guest_control=" + control + "; Path=/; Secure"],
        ["set-cookie", "msg_resource=" + control + "; Path=/room-delayed-follower; Secure"],
      ] });
    });
    writeFileSync(process.env.T09_COOKIE_FOLLOWER_STARTED, "started");
    await fetcher("https://msg.0000.chat/room-delayed-follower");
  `;
  const start = (source: string, extraEnv: Record<string, string> = {}): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], {
      env: { ...process.env, T09_COOKIE_JAR: filePath, ...extraEnv },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Delayed owner process exited ${code}: ${error}`)));
  });

  const owner = start(ownerSource, { T09_COOKIE_READY: readyPath });
  await waitForFile(readyPath);
  const followerStartedPath = `${filePath}.follower-started`;
  const follower = start(followerSource, { T09_COOKIE_FOLLOWER_STARTED: followerStartedPath });
  await waitForFile(followerStartedPath);
  await Promise.all([owner, follower]);

  const jar = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  const control = jar.cookieHeader("https://msg.0000.chat/room-delayed-owner")?.match(/(?:^|; )msg_guest_control=([^;]+)/u)?.[1];
  const ownerResource = jar.cookieHeader("https://msg.0000.chat/room-delayed-owner")?.match(/(?:^|; )msg_resource=([^;]+)/u)?.[1];
  const followerResource = jar.cookieHeader("https://msg.0000.chat/room-delayed-follower")?.match(/(?:^|; )msg_resource=([^;]+)/u)?.[1];
  expect(control).toBe("guest-owner");
  expect(ownerResource).toBe(control);
  expect(followerResource).toBe(control);
});

test("competing dead-owner reclaimers preserve the replacement owner", async () => {
  const { filePath } = await temporaryJar();
  const lockPath = `${filePath}.lock`;
  const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = deadOwner.pid;
  if (!deadPid) throw new Error("Could not allocate a dead lock owner process.");
  await new Promise<void>((resolve, reject) => {
    deadOwner.once("error", reject);
    deadOwner.once("close", () => resolve());
  });
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ owner: "dead-owner", pid: deadPid, startedAt: 0 }), { mode: 0o600 });

  const moduleUrl = new URL("./cookie-jar.ts", import.meta.url).href;
  const goPath = `${filePath}.go`;
  const sources = Array.from({ length: 3 }, (_, index) => ({
    readyPath: `${filePath}.reclaimer-${index}`,
    source: `
      import { existsSync, writeFileSync } from "node:fs";
      import { PersistentCookieJar } from ${JSON.stringify(moduleUrl)};
      const filePath = process.env.T09_COOKIE_JAR;
      const jar = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
      writeFileSync(process.env.T09_COOKIE_READY, "ready");
      while (!existsSync(process.env.T09_COOKIE_GO)) await new Promise((resolve) => setTimeout(resolve, 5));
      const fetcher = jar.wrapFetch(async (_input, init) => {
        const cookie = new Headers(init?.headers).get("cookie") ?? "";
        const control = cookie.split("; ").find((value) => value.startsWith("msg_guest_control="))?.slice("msg_guest_control=".length) ?? ${JSON.stringify(`guest-reclaimer-${index}`)};
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(null, { headers: [
          ["set-cookie", "msg_guest_control=" + control + "; Path=/; Secure"],
          ["set-cookie", "msg_resource=" + control + "; Path=/room-reclaimer-${index}; Secure"],
        ] });
      });
      await fetcher("https://msg.0000.chat/room-reclaimer-${index}");
    `,
  }));
  const start = (source: string, readyPath: string): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], {
      env: { ...process.env, T09_COOKIE_JAR: filePath, T09_COOKIE_READY: readyPath, T09_COOKIE_GO: goPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Reclaimer process exited ${code}: ${error}`)));
  });
  const reclaimers = sources.map(({ source, readyPath }) => start(source, readyPath));
  await Promise.all(sources.map(({ readyPath }) => waitForFile(readyPath)));
  await writeFile(goPath, "go");
  await Promise.all(reclaimers);

  const jar = new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" });
  const control = jar.cookieHeader("https://msg.0000.chat/room-reclaimer-0")?.match(/(?:^|; )msg_guest_control=([^;]+)/u)?.[1];
  expect(control).toBeString();
  for (let index = 0; index < sources.length; index += 1) {
    const resource = jar.cookieHeader(`https://msg.0000.chat/room-reclaimer-${index}`)?.match(/(?:^|; )msg_resource=([^;]+)/u)?.[1];
    expect(resource).toBe(control);
  }
});

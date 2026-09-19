import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { PersistentCookieJar } from "./cookie-jar";

async function temporaryJar(): Promise<{ jar: PersistentCookieJar; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "msg-cookie-jar-"));
  const filePath = join(directory, "cookies.json");
  return { filePath, jar: new PersistentCookieJar({ filePath, serviceOrigin: "https://msg.0000.chat" }) };
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

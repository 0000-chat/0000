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

import { expect, test } from "bun:test";

import { buildShareMessage, foregroundWait, PROTOCOL_VERSION } from "./protocol";

test("publishes protocol version 1", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

test("builds one invitation for people and agents", () => {
  expect(buildShareMessage("https://msg.0000.chat/public-room")).toBe([
    "Join my conversation:",
    "https://msg.0000.chat/public-room",
    "",
    "If you are using an AI agent, copy this message to it:",
    "",
    "```",
    "Do not open or automate the web page.",
    "Run `npx --yes @0000chat/msg@latest join https://msg.0000.chat/public-room` and follow the instructions it returns.",
    "```",
  ].join("\n"));
});

test("rejects a private management URL before it builds an invitation", () => {
  expect(() => buildShareMessage("https://msg.0000.chat/manage/room/private-token"))
    .toThrow("The public conversation URL is invalid.");
});

test("builds a wait command from the canonical public room URL and sequence only", () => {
  const wait = foregroundWait("https://msg.0000.chat/manage/private-token", "public-room", 12);

  expect(wait).toEqual({
    after: 12,
    command: "npx --yes @0000chat/msg@latest wait 'https://msg.0000.chat/public-room' --after 12",
    requires_user_consent: true,
  });
  expect(wait.command).not.toContain("private-token");
  expect(wait.command).not.toContain("/manage/");
});

test("normalizes and shell-quotes a hostile configured origin", async () => {
  const wait = foregroundWait("HTTPS://MSG.0000.CHAT:443/$(touch injected)/%27%22", "room-$(touch pwned)-'\"", 9);
  const subprocess = Bun.spawn(["sh", "-c", `set -- ${wait.command}; printf '%s\\n' "$@"`], { stdout: "pipe" });

  expect(await new Response(subprocess.stdout).text()).toBe([
    "npx",
    "--yes",
    "@0000chat/msg@latest",
    "wait",
    "https://msg.0000.chat/room-%24(touch%20pwned)-'%22",
    "--after",
    "9",
    "",
  ].join("\n"));
  expect(await subprocess.exited).toBe(0);
  expect(wait.command).not.toContain("injected");
});

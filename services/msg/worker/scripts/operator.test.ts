import { expect, test } from "bun:test";

import { operatorBase, parseOperatorCommand } from "./operator";

test("requires explicit confirmation for forced deletion", () => {
  expect(() => parseOperatorCommand(["delete", "room-capability"])).toThrow("--yes");
  expect(parseOperatorCommand(["delete", "room-capability", "--yes"])).toEqual({ kind: "delete", room: "room-capability" });
});

test("accepts only the HTTPS production operator origin", () => {
  expect(operatorBase("https://msg.0000.chat").origin).toBe("https://msg.0000.chat");
  for (const value of ["http://msg.0000.chat", "https://msg.0000.chat/admin", "https://user@msg.0000.chat", "https://other.example"]) expect(() => operatorBase(value)).toThrow("not allowed");
});

test("does not accept an operator token from command arguments", () => {
  expect(() => parseOperatorCommand(["status", "--token", "secret"])).toThrow("Unknown argument");
});

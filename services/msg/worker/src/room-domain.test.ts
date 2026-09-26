import { expect, test } from "bun:test";

import {
  compareCapabilities,
  messageStorageBytes,
  parseMessageInput,
  roomEtag,
  validateIdempotencyKey,
  validateBoundedCursor,
  validateCursor,
  validateReadLimit,
  validateThrough,
} from "./room-domain";

test("requires an author and defaults display_name to it", () => {
  expect(() => parseMessageInput({ kind: "raw", value: "hello" })).toThrow("author");
  expect(parseMessageInput({ kind: "json", value: { author: "agent", content: "hello" } })).toMatchObject({
    author: "agent",
    content: "hello",
    display_name: "agent",
    identity_verified: false,
    semantic_type: "message",
  });
});

test("rejects an invalid cursor", () => {
  expect(() => validateCursor("-1")).toThrow("nonnegative");
  expect(validateCursor("12")).toBe(12);
  expect(validateCursor("")).toBe(0);
  expect(() => validateBoundedCursor("", "after")).toThrow("nonnegative");
  expect(() => validateThrough("")).toThrow("nonnegative");
  expect(validateBoundedCursor("0", "after")).toBe(0);
  expect(validateReadLimit("20")).toBe(20);
  expect(() => validateReadLimit("")).toThrow("positive safe integer");
});

test("uses the latest sequence for a weak room etag", () => {
  expect(roomEtag(9, 3)).toBe('W/"room-9-after-3"');
});

test("compares capability hashes without accepting a prefix", () => {
  expect(compareCapabilities("abc", "abc")).toBe(true);
  expect(compareCapabilities("abc", "ab")).toBe(false);
});

test("allows exactly 64 KiB message content and rejects one extra byte", () => {
  expect(parseMessageInput({ kind: "json", value: { author: "a", content: "a".repeat(64 * 1024) } }).content).toHaveLength(64 * 1024);
  expect(() => parseMessageInput({ kind: "json", value: { author: "a", content: "a".repeat(64 * 1024 + 1) } })).toThrow("too large");
});

test("bounds self-declared metadata and semantic fields", () => {
  expect(() => parseMessageInput({ kind: "json", value: { content: "x", author: "a".repeat(81) } })).toThrow("author");
  expect(() => parseMessageInput({ kind: "json", value: { author: "a", content: "x", semantic_type: "other" } })).toThrow("semantic");
  expect(() => parseMessageInput({ kind: "json", value: { author: "a", content: "x", reply_to: 0 } })).toThrow("reply_to");
  expect(() => validateIdempotencyKey("x".repeat(129))).toThrow("Idempotency-Key");
  expect(parseMessageInput({ kind: "json", value: { author: "a", content: "x", name_password: "secret" } })).toMatchObject({ name_password: "secret" });
  expect(() => parseMessageInput({ kind: "json", value: { author: "a", content: "x", name_password: "" } })).toThrow("name_password");
});

test("accounts for every stored string and record overhead", () => {
  const input = parseMessageInput({ kind: "json", value: { author: "a", client: "c", client_message_id: "i", content: "x", display_name: "d", reply_to: 7, semantic_type: "note" } });
  expect(messageStorageBytes(input)).toBe(64 + 1 + 1 + 1 + 1 + 1 + 1 + 4);
});

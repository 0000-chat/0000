import { expect, test } from "bun:test";

import {
  compareCapabilities,
  messageStorageBytes,
  parseMessageInput,
  roomEtag,
  validateIdempotencyKey,
  validateCursor,
} from "./room-domain";

test("parses raw messages as self-declared unverified messages", () => {
  expect(parseMessageInput({ kind: "raw", value: "hello" })).toMatchObject({
    author: "anonymous",
    content: "hello",
    display_name: "anonymous",
    identity_verified: false,
    semantic_type: "message",
  });
});

test("rejects an invalid cursor", () => {
  expect(() => validateCursor("-1")).toThrow("nonnegative");
  expect(validateCursor("12")).toBe(12);
});

test("uses the latest sequence for a weak room etag", () => {
  expect(roomEtag(9, 3)).toBe('W/"room-9-after-3"');
});

test("compares capability hashes without accepting a prefix", () => {
  expect(compareCapabilities("abc", "abc")).toBe(true);
  expect(compareCapabilities("abc", "ab")).toBe(false);
});

test("allows exactly 64 KiB message content and rejects one extra byte", () => {
  expect(parseMessageInput({ kind: "raw", value: "a".repeat(64 * 1024) }).content).toHaveLength(64 * 1024);
  expect(() => parseMessageInput({ kind: "raw", value: "a".repeat(64 * 1024 + 1) })).toThrow("too large");
});

test("bounds self-declared metadata and semantic fields", () => {
  expect(() => parseMessageInput({ kind: "json", value: { content: "x", author: "a".repeat(81) } })).toThrow("author");
  expect(() => parseMessageInput({ kind: "json", value: { content: "x", semantic_type: "other" } })).toThrow("semantic");
  expect(() => parseMessageInput({ kind: "json", value: { content: "x", reply_to: 0 } })).toThrow("reply_to");
  expect(() => validateIdempotencyKey("x".repeat(129))).toThrow("Idempotency-Key");
});

test("accounts for every stored string and record overhead", () => {
  const input = parseMessageInput({ kind: "json", value: { author: "a", client: "c", client_message_id: "i", content: "x", display_name: "d", reply_to: 7, semantic_type: "note" } });
  expect(messageStorageBytes(input)).toBe(64 + 1 + 1 + 1 + 1 + 1 + 1 + 4);
});

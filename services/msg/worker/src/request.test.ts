import { expect, test } from "bun:test";

import { ProtocolError } from "./errors";
import {
  negotiateCreateRepresentation,
  negotiateRepresentation,
  parseRequestBody,
} from "./request";

test("negotiates HTML before JSON and Markdown fallback", () => {
  expect(negotiateRepresentation("application/json, text/html")).toBe("html");
  expect(negotiateRepresentation("application/json")).toBe("json");
  expect(negotiateRepresentation(null)).toBe("markdown");
});

test("uses JSON for creation unless text plain is requested", () => {
  expect(negotiateCreateRepresentation("text/html")).toBe("json");
  expect(negotiateCreateRepresentation("application/json")).toBe("json");
  expect(negotiateCreateRepresentation("text/plain")).toBe("markdown");
});

test("uses valid Accept quality values and wildcards for representations", () => {
  expect(
    negotiateRepresentation("application/json;q=1, text/html;q=0"),
  ).toBe("json");
  expect(
    negotiateRepresentation("text/html;q=0.2, application/json;Q=0.8"),
  ).toBe("json");
  expect(negotiateRepresentation("application/*;q=0.7")).toBe("json");
  expect(negotiateRepresentation("*/*;q=0.5")).toBe("html");
});

test("does not select text plain creation output when its quality is zero", () => {
  expect(
    negotiateCreateRepresentation("text/plain;q=0, application/json;q=1"),
  ).toBe("json");
});

test("uses the most specific Accept range even when it rejects a representation", () => {
  expect(negotiateRepresentation("text/html;q=0, */*;q=1")).toBe("json");
  expect(
    negotiateRepresentation("application/json;q=0, application/*;q=1"),
  ).toBe("markdown");
  expect(
    negotiateCreateRepresentation("text/plain;q=0, */*;q=1"),
  ).toBe("json");
});

test("parses UTF-8 text and form bodies as raw text", async () => {
  const absent = await parseRequestBody(
    new Request("https://msg.0000.chat/", { method: "POST" }),
  );
  const plain = await parseRequestBody(
    new Request("https://msg.0000.chat/", {
      body: "hello",
      headers: { "content-type": "text/plain; charset=utf-8" },
      method: "POST",
    }),
  );
  const form = await parseRequestBody(
    new Request("https://msg.0000.chat/", {
      body: "message=hello",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    }),
  );

  expect(absent).toEqual({ kind: "raw", value: "" });
  expect(plain).toEqual({ kind: "raw", value: "hello" });
  expect(form).toEqual({ kind: "raw", value: "message=hello" });
});

test("parses JSON request bodies as structured values", async () => {
  const body = await parseRequestBody(
    new Request("https://msg.0000.chat/", {
      body: '{"message":"hello"}',
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );

  expect(body).toEqual({ kind: "json", value: { message: "hello" } });
});

test("returns stable errors for malformed and oversize bodies", async () => {
  const malformed = parseRequestBody(
    new Request("https://msg.0000.chat/", {
      body: "{not-json}",
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  await expect(malformed).rejects.toMatchObject<Partial<ProtocolError>>({
    code: "invalid_json",
  });
  await expect(
    parseRequestBody(
      new Request("https://msg.0000.chat/", {
        body: "12345",
        headers: { "content-type": "text/plain" },
        method: "POST",
      }),
      { maxBytes: 4 },
    ),
  ).rejects.toMatchObject<Partial<ProtocolError>>({
    code: "body_too_large",
  });
});

test("rejects unsupported content types before reading small or large bodies", async () => {
  const small = unsupportedBodyRequest("1");
  const large = unsupportedBodyRequest("100000");

  await expect(parseRequestBody(small.request, { maxBytes: 4 })).rejects.toMatchObject<
    Partial<ProtocolError>
  >({ code: "unsupported_media_type", status: 415 });
  await expect(parseRequestBody(large.request, { maxBytes: 4 })).rejects.toMatchObject<
    Partial<ProtocolError>
  >({ code: "unsupported_media_type", status: 415 });
  expect(small.reads()).toBe(0);
  expect(large.reads()).toBe(0);
});

function unsupportedBodyRequest(contentLength: string): {
  readonly reads: () => number;
  readonly request: Request;
} {
  let reads = 0;
  const body = {
    getReader() {
      reads += 1;
      throw new Error("Unsupported bodies must not be read.");
    },
  } as unknown as ReadableStream<Uint8Array>;
  return {
    reads: () => reads,
    request: {
      body,
      headers: new Headers({
        "content-length": contentLength,
        "content-type": "application/octet-stream",
      }),
    } as Request,
  };
}

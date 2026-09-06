import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  canonicalJsonBytes,
  canonicalJsonStringify,
  utf8ByteLength,
} from "../../archive/canonical-json";
import { MAX_CANONICAL_JSON_DEPTH } from "@communicator/contracts";

describe("canonical JSON", () => {
  it("sorts nested object keys by UTF-16 code units and preserves array order", () => {
    const value = {
      z: 0,
      arr: [{ b: 2, a: 1 }, 3],
      a: { z: 2, a: 1 },
    };

    expect(canonicalJsonStringify(value)).toBe(
      '{"a":{"a":1,"z":2},"arr":[{"a":1,"b":2},3],"z":0}',
    );
  });

  it("produces identical bytes for different insertion orders without mutating inputs", () => {
    const first = { payload: { z: "é", a: 1 }, list: ["first", "second"] };
    const second = { list: ["first", "second"], payload: { a: 1, z: "é" } };
    const firstBefore = structuredClone(first);
    const secondBefore = structuredClone(second);

    expect(canonicalJsonBytes(first)).toEqual(canonicalJsonBytes(second));
    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);
  });

  it("counts UTF-8 bytes rather than JavaScript string characters", () => {
    expect(utf8ByteLength("é😀")).toBe(6);
    expect(canonicalJsonBytes({ text: "é😀" }).byteLength).toBe(
      utf8ByteLength('{"text":"é😀"}'),
    );
  });

  it.each(["direct cycle", "indirect cycle", "prototype-sensitive key"])(
    "rejects %s as archive_invalid without exposing fixture content",
    (kind) => {
      const fixtureBody = "secret fixture message body";
      let value: unknown;
      if (kind === "direct cycle") {
        const object: Record<string, unknown> = { body: fixtureBody };
        object.self = object;
        value = object;
      } else if (kind === "indirect cycle") {
        const first: Record<string, unknown> = { body: fixtureBody };
        const second: Record<string, unknown> = { first };
        first.second = second;
        value = first;
      } else {
        const object: Record<string, unknown> = { body: fixtureBody };
        Object.defineProperty(object, "__proto__", {
          configurable: true,
          enumerable: true,
          value: fixtureBody,
          writable: true,
        });
        value = object;
      }

      let caught: unknown;
      try {
        canonicalJsonStringify(value);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ArchiveError);
      expect((caught as ArchiveError).code).toBe("archive_invalid");
      expect((caught as Error).message).not.toContain(fixtureBody);
      expect((caught as Error).message).not.toContain("RangeError");
    },
  );

  it("snapshots a stateful Proxy once instead of serializing a second inconsistent view", () => {
    const target = { z: 1, a: 2 };
    let ownKeysCalls = 0;
    const value = new Proxy(target, {
      ownKeys: () => {
        ownKeysCalls += 1;
        return ownKeysCalls === 1 ? ["z", "a"] : ["z"];
      },
    });

    let result: string | undefined;
    let caught: unknown;
    try {
      result = canonicalJsonStringify(value);
    } catch (error) {
      caught = error;
    }

    expect(ownKeysCalls).toBe(1);
    expect(caught).toBeUndefined();
    expect(result).toBe('{"a":2,"z":1}');
  });

  it("keeps the canonical JSON depth bound explicit", () => {
    expect(MAX_CANONICAL_JSON_DEPTH).toBe(32);
  });

  it("rejects arrays whose indexed values are non-enumerable", () => {
    const value = ["hidden"];
    Object.defineProperty(value, "0", {
      configurable: true,
      enumerable: false,
      value: "hidden",
      writable: true,
    });

    expect(() => canonicalJsonStringify(value)).toThrowError(ArchiveError);
    expect(() => canonicalJsonStringify(value)).toThrowError(
      expect.objectContaining({ code: "archive_invalid" }),
    );
  });
});

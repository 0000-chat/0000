import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  executeRestrictedProgram,
  RestrictedProgramError,
} from "../src/restricted-program";

const okHost = {
  async invoke(call: { name: string; input: Record<string, unknown> }) {
    return {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { name: call.name, input: call.input },
    };
  },
};

test("restricted programs authorize only host calls and support dependent values", async () => {
  const result = await executeRestrictedProgram(
    "const first = await tools.read({resource: 'room'}); return {name: first.name};",
    okHost,
  );
  assert.deepEqual(result.result, { name: "read" });
  assert.equal(result.calls, 1);
});

test("restricted programs reject globals and validate the complete program before effects", async () => {
  let calls = 0;
  await assert.rejects(
    executeRestrictedProgram("return await fetch('https://example.com');", {
      async invoke() {
        calls += 1;
        return { content: [] };
      },
    }),
    RestrictedProgramError,
  );
  await assert.rejects(
    executeRestrictedProgram(
      "return await tools.read({}); unsupported;",
      okHost,
    ),
    RestrictedProgramError,
  );
  assert.equal(calls, 0);
});

test("restricted programs enforce call, nesting, numeric, and timeout bounds", async () => {
  await assert.rejects(
    executeRestrictedProgram(
      "return await tools.read({value: 1e999});",
      okHost,
    ),
    RestrictedProgramError,
  );
  await assert.rejects(
    executeRestrictedProgram(
      "return await tools.read({a: {b: {c: {d: {e: {f: {g: 1}}}}}}});",
      okHost,
      {
        maxProgramBytes: 32 * 1024,
        maxStatements: 64,
        maxCalls: 8,
        maxMilliseconds: 100,
        maxOutputBytes: 64 * 1024,
        maxNodes: 2048,
        maxDepth: 3,
      },
    ),
    RestrictedProgramError,
  );
  await assert.rejects(
    executeRestrictedProgram(
      "return await tools.read({});",
      { invoke: async () => new Promise(() => {}) },
      {
        maxProgramBytes: 32 * 1024,
        maxStatements: 64,
        maxCalls: 8,
        maxMilliseconds: 10,
        maxOutputBytes: 64 * 1024,
        maxNodes: 2048,
        maxDepth: 32,
      },
    ),
    RestrictedProgramError,
  );
});

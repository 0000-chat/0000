import { describe, expect, test } from "bun:test";
import { toolDefinitions, validateToolInput } from "./mcp";

describe("Helm Streams MCP contracts", () => {
  test("accepts modern upsert fields and preserves legacy aliases", () => {
    expect(
      validateToolInput("upsert_stream", {
        streamId: "travel",
        title: "Travel",
        ownerBot: "helm",
        about: "Choose the next travel step.",
        timeline: [{ at: "2026-09-06T00:00:00Z", text: "Research started" }],
        status: "needs_decision",
        choices: [
          { id: "send", label: "Send", value: "send_draft", recommended: true },
        ],
        summary: "Legacy summary",
        history: ["Legacy event"],
        needsDon: true,
      }),
    ).toEqual({
      streamId: "travel",
      title: "Travel",
      ownerBot: "helm",
      about: "Choose the next travel step.",
      timeline: [{ at: "2026-09-06T00:00:00Z", text: "Research started" }],
      status: "needs_decision",
      choices: [
        { id: "send", label: "Send", value: "send_draft", recommended: true },
      ],
      summary: "Legacy summary",
      history: ["Legacy event"],
      needsDon: true,
    });
  });

  test("strictly validates modern upsert fields and choice recommendations", () => {
    expect(() =>
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        timeline: [{ at: "now", text: "event", extra: true }],
      }),
    ).toThrow("unexpected");
    expect(() =>
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        status: "active-ish",
      }),
    ).toThrow("status");
    expect(() =>
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        choices: [
          { id: "a", label: "A", value: "a", recommended: true },
          { id: "b", label: "B", value: "b", recommended: true },
        ],
      }),
    ).toThrow("recommended");
    expect(() =>
      validateToolInput("upsert_stream", {
        streamId: "one",
        title: "One",
        ownerBot: "helm",
        about: 4,
      }),
    ).toThrow("about");
  });

  test("accepts legacy status values for upsert while keeping patch status modern-only", () => {
    for (const status of ["active", "deferred", "archived"]) {
      expect(
        validateToolInput("upsert_stream", {
          streamId: "one",
          title: "One",
          ownerBot: "helm",
          status,
        }),
      ).toMatchObject({ status });
    }
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [{ streamId: "one", status: "active" }],
      }),
    ).toThrow("status");

    const upsert = toolDefinitions.find(
      (tool) => tool.name === "upsert_stream",
    );
    const patch = toolDefinitions.find((tool) => tool.name === "patch_streams");
    expect(upsert).toBeDefined();
    expect(patch).toBeDefined();
    expect(
      (upsert!.inputSchema as { properties: { status: { enum: string[] } } })
        .properties.status.enum,
    ).toEqual([
      "needs_decision",
      "ongoing",
      "no_action",
      "active",
      "deferred",
      "archived",
    ]);
    expect(
      (
        patch!.inputSchema as {
          properties: {
            patches: { items: { properties: { status: { enum: string[] } } } };
          };
        }
      ).properties.patches.items.properties.status.enum,
    ).toEqual(["needs_decision", "ongoing", "no_action"]);
  });

  test("validates recommended choices for set_stream_choices", () => {
    expect(
      validateToolInput("set_stream_choices", {
        streamId: "one",
        choices: [{ id: "a", label: "A", value: "a", recommended: true }],
      }),
    ).toEqual({
      streamId: "one",
      choices: [{ id: "a", label: "A", value: "a", recommended: true }],
    });
    expect(() =>
      validateToolInput("set_stream_choices", {
        streamId: "one",
        choices: [{ id: "a", label: "A", value: "a", recommended: "yes" }],
      }),
    ).toThrow("recommended");
    expect(() =>
      validateToolInput("set_stream_choices", {
        streamId: "one",
        choices: [
          { id: "a", label: "A", value: "a", recommended: true },
          { id: "b", label: "B", value: "b", recommended: true },
        ],
      }),
    ).toThrow("recommended");
  });

  test("accepts only unique nonempty patch batches with mutable fields", () => {
    expect(
      validateToolInput("patch_streams", {
        patches: [
          { streamId: "one", status: "ongoing" },
          { streamId: "two", priority: 2 },
        ],
      }),
    ).toEqual({
      patches: [
        { streamId: "one", status: "ongoing" },
        { streamId: "two", priority: 2 },
      ],
    });
    expect(() => validateToolInput("patch_streams", { patches: [] })).toThrow(
      "nonempty",
    );
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [
          { streamId: "one", status: "ongoing" },
          { streamId: "one", priority: 2 },
        ],
      }),
    ).toThrow("unique");
    expect(() =>
      validateToolInput("patch_streams", { patches: [{ streamId: "one" }] }),
    ).toThrow("mutable");
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [{ streamId: "one", needsDon: true }],
      }),
    ).toThrow("unexpected");
    expect(() =>
      validateToolInput("patch_streams", {
        patches: [{ streamId: "one", status: "active-ish" }],
      }),
    ).toThrow("status");
  });

  test("publishes strict schemas for modern stream contracts", () => {
    const upsert = toolDefinitions.find(
      (tool) => tool.name === "upsert_stream",
    );
    const setChoices = toolDefinitions.find(
      (tool) => tool.name === "set_stream_choices",
    );
    const patch = toolDefinitions.find((tool) => tool.name === "patch_streams");
    if (!upsert || !setChoices || !patch)
      throw new Error("modern MCP tools are missing");
    expect(upsert.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(
      (upsert.inputSchema as { properties: Record<string, unknown> })
        .properties,
    ).toHaveProperty("about");
    expect(
      (upsert.inputSchema as { properties: Record<string, unknown> })
        .properties,
    ).toHaveProperty("timeline");
    expect(
      (upsert.inputSchema as { properties: Record<string, unknown> })
        .properties,
    ).toHaveProperty("status");
    expect(
      (upsert.inputSchema as { properties: Record<string, unknown> })
        .properties,
    ).toHaveProperty("choices");
    expect(
      (
        setChoices.inputSchema as {
          properties: { choices: { items: Record<string, unknown> } };
        }
      ).properties.choices.items.properties,
    ).toHaveProperty("recommended");
    expect(patch.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["patches"],
    });
    expect(
      (
        patch.inputSchema as {
          properties: { patches: { items: { additionalProperties: boolean } } };
        }
      ).properties.patches.items.additionalProperties,
    ).toBe(false);
  });
});

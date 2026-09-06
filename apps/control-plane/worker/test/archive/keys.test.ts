import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  deriveArchiveKeys,
  deriveManifestPrefix,
  parseArchiveKey,
} from "../../archive/keys";

describe("archive key derivation", () => {
  it("derives the exact UTC data and manifest keys", () => {
    expect(
      deriveArchiveKeys(
        "tenant_pilot",
        "batch_01abc",
        "2026-09-07T01:02:03.000Z",
      ),
    ).toEqual({
      dataKey: "events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz",
      manifestKey: "manifests/tenant_pilot/2026/09/07/01/batch_01abc.json",
    });
  });

  it("uses the instant represented by an offset-bearing timestamp", () => {
    expect(
      deriveArchiveKeys(
        "tenant_pilot",
        "batch_01abc",
        "2026-09-07T01:02:03.000+02:00",
      ).dataKey,
    ).toBe("events/tenant_pilot/2026/09/06/23/batch_01abc.jsonl.gz");
  });

  it("derives the tenant list prefix internally", () => {
    expect(deriveManifestPrefix("tenant_pilot")).toBe("manifests/tenant_pilot/");
  });

  it.each([
    ["tenant/../other", "batch_01abc"],
    ["tenant_pilot", "batch_../other"],
    ["tenant_pilot", "batch_%2e%2e"],
    ["tenant_pilot", "batch_01/other"],
    ["Tenant_pilot", "batch_01abc"],
  ])("rejects caller-like path input (%s, %s)", (tenantId, batchId) => {
    expect(() => deriveArchiveKeys(tenantId, batchId, "2026-09-07T01:02:03.000Z"))
      .toThrowError(ArchiveError);
  });

  it("parses only a valid derived key", () => {
    expect(
      parseArchiveKey("events/tenant_pilot/2026/09/07/01/batch_01abc.jsonl.gz"),
    ).toEqual({
      kind: "data",
      tenantId: "tenant_pilot",
      year: "2026",
      month: "09",
      day: "07",
      hour: "01",
      batchId: "batch_01abc",
    });
    expect(parseArchiveKey("events/tenant_pilot/2026/09/07/01/batch_01abc.json"))
      .toBeNull();
  });
});

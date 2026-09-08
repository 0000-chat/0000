import fixture from "../../../../../services/matrix-gateway/testdata/ingestion-contract-v1.json";
import type { IngestionBatchRequest } from "@communicator/contracts";
import { describe, expect, it } from "vitest";
import { encodeCanonicalEventBatch } from "../../archive/codec";
import { recomputeIngestionBatchId } from "../../ingestion/prepare";

type IngestionContractVector = {
  request: IngestionBatchRequest;
  canonical_jsonl: string;
  canonical_sha256: string;
};

// JSON module imports intentionally widen numeric/string literals. Keep the
// checked-in vector's contract shape explicit at this test boundary so the
// production encoder and batch identity function are still exercised directly.
const contractFixture = fixture as unknown as IngestionContractVector;

describe("matrix gateway ingestion contract vector", () => {
  it("reproduces the canonical JSONL bytes and immutable batch identity", async () => {
    const encoded = await encodeCanonicalEventBatch({
      tenantId: contractFixture.request.tenant_id,
      events: contractFixture.request.events,
    });

    expect(new TextDecoder().decode(encoded.canonicalJsonl)).toBe(
      contractFixture.canonical_jsonl,
    );
    expect(encoded.canonicalSha256).toBe(contractFixture.canonical_sha256);
    expect(
      await recomputeIngestionBatchId(
        contractFixture.request,
        encoded.canonicalSha256,
      ),
    ).toBe(contractFixture.request.batch_id);
  });
});

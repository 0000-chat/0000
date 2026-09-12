import { describe, expect, it } from "vitest";
import app from "../app";

describe("GET /api/v1/health", () => {
  it("returns a non-secret health document", async () => {
    const response = await app.request("http://example.test/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "communicator-control-plane",
      data_mode: "unconfigured",
    });
  });
});

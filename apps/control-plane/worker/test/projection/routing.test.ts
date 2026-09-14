import { describe, expect, it } from "vitest";
import { env as runtimeEnv } from "cloudflare:workers";
import type { ProjectionStatusInput } from "@communicator/contracts";
import { runInDurableObject } from "cloudflare:test";
import configText from "../../../wrangler.jsonc?raw";
import {
  ProjectionError,
  getProjectionErrorCause,
  projectionError,
  safeProjectionError,
} from "../../projection/errors";
import { getTenantProjection } from "../../projection/routing";
import { TenantProjectionDO } from "../../projection/tenant-projection";

type WranglerConfig = {
  exports?: Record<string, unknown>;
  durable_objects?: { bindings?: Array<Record<string, unknown>> };
  env?: Record<
    string,
    {
      durable_objects?: { bindings?: Array<Record<string, unknown>> };
    }
  >;
  migrations?: unknown;
};

const config = JSON.parse(configText) as WranglerConfig;

const bindingName = "TENANT_PROJECTION";
const className = "TenantProjectionDO";
const expectedBinding = { name: bindingName, class_name: className };
const expectedLinkBinding = {
  name: "LINK_SESSIONS",
  class_name: "LinkSessionDO",
};

const validStatusInput: ProjectionStatusInput = {
  schema_version: 1,
  tenant_id: "tenant_pilot",
  authorization: {
    schema_version: 1,
    tenant_id: "tenant_pilot",
    principal_id: "principal_pilot",
    allowed_identity_ids: [],
    scopes: ["projection.status"],
  },
};

const stub = {
  marker: "tenant-projection-stub",
} as unknown as DurableObjectStub<TenantProjectionDO>;

describe("tenant projection routing", () => {
  it("routes a canonical tenant ID through getByName unchanged", () => {
    let requestedName: string | undefined;
    const namespace = {
      getByName(name: string) {
        requestedName = name;
        return stub;
      },
    } as unknown as DurableObjectNamespace<TenantProjectionDO>;
    const runtimeEnv = {
      TENANT_PROJECTION: namespace,
    } as Pick<Cloudflare.Env, "TENANT_PROJECTION">;

    expect(getTenantProjection(runtimeEnv, "tenant_pilot")).toBe(stub);
    expect(requestedName).toBe("tenant_pilot");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["symbol", Symbol("tenant_pilot")],
    ["array", ["tenant_pilot"]],
    [
      "prototype-sensitive object",
      Object.create({ tenant_id: "tenant_pilot" }),
    ],
    [
      "getter object",
      Object.defineProperty({}, "tenant_id", {
        enumerable: true,
        get() {
          throw new Error("tenant getter must not run");
        },
      }),
    ],
    ["invalid resource ID", "tenant-PILOT"],
    ["trailing whitespace", "tenant_pilot "],
  ])("rejects %s before touching the binding", (_label, tenantId) => {
    let bindingTouched = false;
    const runtimeEnv = Object.defineProperty({}, bindingName, {
      configurable: true,
      enumerable: true,
      get() {
        bindingTouched = true;
        throw new Error("binding must not be read");
      },
    }) as Pick<Cloudflare.Env, "TENANT_PROJECTION">;

    expect(() => getTenantProjection(runtimeEnv, tenantId)).toThrowError(
      expect.objectContaining({
        code: "projection_invalid",
        message: "projection_invalid",
      }),
    );
    expect(bindingTouched).toBe(false);
  });

  it("keeps the durable object class and binding names exact", () => {
    expect(TenantProjectionDO.name).toBe(className);
    expect(config.durable_objects).toEqual({
      bindings: [expectedBinding, expectedLinkBinding],
    });
  });

  it("sanitizes ProjectionError public data without an own cause property", () => {
    const sensitive =
      "payload=secret auth=Bearer-token cursor=opaque SQL=SELECT-secret";
    const error = new ProjectionError("projection_invalid", {
      cause: sensitive,
    });

    expect(error).toBeInstanceOf(ProjectionError);
    expect(error.name).toBe("ProjectionError");
    expect(error.code).toBe("projection_invalid");
    expect(error.message).toBe("projection_invalid");
    expect(Object.keys(error)).toEqual(["code"]);
    expect({ ...error }).toEqual({ code: "projection_invalid" });
    expect(JSON.stringify(error)).not.toContain(sensitive);
    expect(Object.values(error)).not.toContain(sensitive);
    expect(Object.getOwnPropertyNames(error)).not.toContain("cause");
    expect(Reflect.ownKeys(error)).not.toContain("cause");
    for (const key of Reflect.ownKeys(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor && "value" in descriptor) {
        expect(String(descriptor.value)).not.toContain(sensitive);
      }
    }
    expect(getProjectionErrorCause(error)).toBe(sensitive);

    const existing = projectionError("projection_conflict", sensitive);
    expect(safeProjectionError(existing, "projection_unavailable")).toBe(
      existing,
    );

    const rawError = new Error(sensitive);
    const wrapped = safeProjectionError(rawError, "projection_unavailable");
    expect(wrapped).toBeInstanceOf(ProjectionError);
    expect(wrapped.code).toBe("projection_unavailable");
    expect(wrapped.message).toBe("projection_unavailable");
    expect(Object.keys(wrapped)).toEqual(["code"]);
    expect(JSON.stringify(wrapped)).not.toContain(sensitive);
    expect(Object.getOwnPropertyNames(wrapped)).not.toContain("cause");
    expect(Reflect.ownKeys(wrapped)).not.toContain("cause");
    expect(getProjectionErrorCause(wrapped)).toBe(rawError);
  });

  it("returns pre-initialize getStatus as a sanitized not-found error", async () => {
    const statusStub = runtimeEnv.TENANT_PROJECTION.getByName("tenant_pilot");
    // The current Vitest Workers RPC bridge reports an unhandled rejection for
    // direct rejected-stub assertions, even with an immediate rejection
    // handler, and adds bridge metadata to the caller error. runInDurableObject
    // is the strongest deterministic boundary this harness supports without
    // adding an RPC solely for this test.
    const rejection = await runInDurableObject(statusStub, async (instance) => {
      try {
        await instance.getStatus(validStatusInput);
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(rejection).toBeInstanceOf(ProjectionError);
    expect(rejection).toMatchObject({
      code: "projection_not_found",
      message: "projection_not_found",
    });
    expect(Object.keys(rejection as object)).toEqual(["code"]);
    expect(JSON.stringify(rejection)).not.toContain(
      JSON.stringify(validStatusInput),
    );
  });
});

describe("tenant projection Wrangler configuration", () => {
  it("declares the SQLite export exactly and repeats the binding per environment", () => {
    expect(config.exports).toEqual({
      [className]: { type: "durable-object", storage: "sqlite" },
      LinkSessionDO: { type: "durable-object", storage: "sqlite" },
    });

    for (const environment of ["staging", "production"] as const) {
      expect(config.env?.[environment]?.durable_objects).toEqual({
        bindings: [expectedBinding, expectedLinkBinding],
      });
    }
  });

  it("does not introduce a legacy migrations declaration", () => {
    expect(config.migrations).toBeUndefined();
  });
});

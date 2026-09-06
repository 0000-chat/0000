import { describe, expect, it } from "vitest";
import configText from "../../../wrangler.jsonc?raw";
import { getTenantProjection } from "../../projection/routing";
import { TenantProjectionDO } from "../../projection/tenant-projection";

type WranglerConfig = {
  exports?: Record<string, unknown>;
  durable_objects?: { bindings?: Array<Record<string, unknown>> };
  env?: Record<string, {
    durable_objects?: { bindings?: Array<Record<string, unknown>> };
  }>;
  migrations?: unknown;
};

const config = JSON.parse(configText) as WranglerConfig;

const bindingName = "TENANT_PROJECTION";
const className = "TenantProjectionDO";
const expectedBinding = { name: bindingName, class_name: className };

const stub = { marker: "tenant-projection-stub" } as unknown as DurableObjectStub<
  TenantProjectionDO
>;

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
    ["prototype-sensitive object", Object.create({ tenant_id: "tenant_pilot" })],
    ["getter object", Object.defineProperty({}, "tenant_id", {
      enumerable: true,
      get() {
        throw new Error("tenant getter must not run");
      },
    })],
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
    expect(config.durable_objects).toEqual({ bindings: [expectedBinding] });
  });
});

describe("tenant projection Wrangler configuration", () => {
  it("declares the SQLite export exactly and repeats the binding per environment", () => {
    expect(config.exports).toEqual({
      [className]: { type: "durable-object", storage: "sqlite" },
    });

    for (const environment of ["staging", "production"] as const) {
      expect(config.env?.[environment]?.durable_objects).toEqual({
        bindings: [expectedBinding],
      });
    }
  });

  it("does not introduce a legacy migrations declaration", () => {
    expect(config.migrations).toBeUndefined();
  });
});

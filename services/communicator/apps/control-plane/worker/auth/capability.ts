import type { MiddlewareHandler } from "hono";
import type { AuthorizationVariables } from "./middleware";

type CapabilityEnvironment = {
  Bindings: Cloudflare.Env;
  Variables: AuthorizationVariables;
};

/**
 * Apply a route-level Platform capability ceiling after authentication. Local
 * identity grants remain the resource check performed by each handler; this
 * middleware prevents a broad local owner/admin role from bypassing a
 * deliberately narrowed Platform credential.
 */
export function requirePlatformCapability(
  ...required: readonly string[]
): MiddlewareHandler<CapabilityEnvironment> {
  return async (context, next) => {
    const capabilities = new Set(context.get("platformCapabilities") ?? []);
    // Legacy component fixtures do not carry Platform context. They retain
    // their pre-adoption route behavior while deployed requests always do.
    if (
      context.get("platformPrincipal") !== undefined &&
      required.some((capability) => !capabilities.has(capability))
    ) {
      return context.json(
        { error: { code: "forbidden", message: "Forbidden" } },
        403,
      );
    }
    await next();
  };
}

export function requirePlatformCapabilityForMethods(
  methods: ReadonlyMap<string, readonly string[]>,
  fallback: readonly string[],
): MiddlewareHandler<CapabilityEnvironment> {
  return async (context, next) => {
    const required = methods.get(context.req.method.toUpperCase()) ?? fallback;
    const capabilities = new Set(context.get("platformCapabilities") ?? []);
    if (
      context.get("platformPrincipal") !== undefined &&
      required.some((capability) => !capabilities.has(capability))
    ) {
      return context.json(
        { error: { code: "forbidden", message: "Forbidden" } },
        403,
      );
    }
    await next();
  };
}

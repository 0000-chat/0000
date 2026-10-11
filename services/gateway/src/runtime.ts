import {
  isAgentPrincipal,
  isHumanPrincipal,
  type AgentPrincipal,
  type HumanPrincipal,
  type PlatformIdentityVerifier,
  type ProfileManagementAuthorizer,
  type ServiceToolDeclaration,
} from "./access";
import { createGatewayApp, type GatewayDependencies } from "./app";
import {
  createMsgServiceCatalog,
  type GatewayServiceBinding,
} from "./msg-adapter";
import { D1ProfileGrantStore, type D1DatabaseLike } from "./profile-store";

/**
 * Platform owns credential issuance and verification. The named calls below
 * are the complete Gateway-side verification contract; missing calls fail
 * closed. The raw credential/session is never exposed to a program or Msg.
 */
export interface PlatformVerificationBinding {
  inspectAgentCredential?(
    rawCredential: string,
  ): Promise<AgentPrincipal | null>;
  inspectHumanSession?(
    rawSession: string,
    organizationId: string,
  ): Promise<HumanPrincipal | null>;
  canManageProfile?(
    rawSession: string,
    organizationId: string,
    profileId: string,
  ): Promise<boolean>;
}

export interface GatewayRuntimeBindings {
  readonly GATEWAY_DB?: D1DatabaseLike;
  readonly PLATFORM_VERIFICATION?: PlatformVerificationBinding;
  readonly MSG?: GatewayServiceBinding;
}

export interface GatewayRuntimeOptions {
  readonly serviceTools?: readonly ServiceToolDeclaration[];
}

export function createConfiguredGatewayApp(
  bindings: GatewayRuntimeBindings,
  options: GatewayRuntimeOptions = {},
) {
  const platform = bindings.PLATFORM_VERIFICATION
    ? createPlatformVerifier(bindings.PLATFORM_VERIFICATION)
    : unavailableIdentityVerifier();
  const serviceTools = options.serviceTools ?? [];
  const serviceToolCatalog =
    options.serviceTools === undefined && bindings.MSG
      ? createMsgServiceCatalog({ binding: bindings.MSG })
      : undefined;
  const profileGrantStore = bindings.GATEWAY_DB
    ? new D1ProfileGrantStore(
        bindings.GATEWAY_DB,
        serviceTools.map((tool) => tool.operationId),
        serviceToolCatalog
          ? async () =>
              (await serviceToolCatalog.getDeclarations()).map(
                (tool) => tool.operationId,
              )
          : undefined,
      )
    : unavailableProfileGrantStore();
  const dependencies: GatewayDependencies = {
    identityVerifier: platform,
    profileGrantStore,
    profileManagementAuthorizer: platform,
    serviceTools,
    serviceToolCatalog,
  };
  return createGatewayApp(dependencies);
}

function createPlatformVerifier(
  binding: PlatformVerificationBinding,
): PlatformIdentityVerifier & ProfileManagementAuthorizer {
  return {
    async verifyAgentCredential(request) {
      const credential = bearerCredential(request);
      if (!credential || !binding.inspectAgentCredential) {
        throw new Error("Platform agent verification is unavailable.");
      }
      const value = await withPlatformDeadline(() =>
        binding.inspectAgentCredential!(credential),
      );
      return isAgentPrincipal(value) ? value : null;
    },
    async verifyHumanSession(request) {
      const session = platformSessionCookie(request);
      const organizationId = request.headers.get("x-0000-organization");
      if (!session || !organizationId || !binding.inspectHumanSession) {
        throw new Error("Platform human verification is unavailable.");
      }
      const value = await withPlatformDeadline(() =>
        binding.inspectHumanSession!(session, organizationId),
      );
      return isHumanPrincipal(value) ? value : null;
    },
    async canManageProfile(_principal, organizationId, profileId, request) {
      const session = platformSessionCookie(request);
      if (!session || !binding.canManageProfile) return false;
      const permitted = await withPlatformDeadline(() =>
        binding.canManageProfile!(session, organizationId, profileId),
      );
      return permitted === true;
    },
  };
}

const PLATFORM_VERIFY_TIMEOUT_MS = 3_000;

async function withPlatformDeadline<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Platform verification timed out.")),
          PLATFORM_VERIFY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function bearerCredential(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/u.exec(value);
  return match?.[1] ?? null;
}

function platformSessionCookie(request: Request): string | null {
  const value = request.headers.get("cookie");
  if (!value) return null;
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== "platform_session") continue;
    const session = part.slice(separator + 1).trim();
    return session.length > 0 ? session : null;
  }
  return null;
}

function unavailableIdentityVerifier(): PlatformIdentityVerifier &
  ProfileManagementAuthorizer {
  const unavailable = async (): Promise<never> => {
    throw new Error("Platform Verification binding is not configured.");
  };
  return {
    verifyAgentCredential: unavailable,
    verifyHumanSession: unavailable,
    canManageProfile: unavailable,
  };
}

function unavailableProfileGrantStore() {
  return {
    async getGrantedOperationIds(): Promise<null> {
      throw new Error("Gateway D1 binding is not configured.");
    },
  };
}

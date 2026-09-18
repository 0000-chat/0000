export interface PrincipalBase {
  version: 1;
  authority: string;
  subjectId: string;
  credentialId: string;
  audience: string;
  capabilities: string[];
  /** Guests remain valid while their service-owned resource grants exist. */
  expiresAt: string | null;
}

export interface HumanPrincipal extends PrincipalBase {
  kind: "human";
  organizationId: string;
  membershipId: string;
}

export interface AgentPrincipal extends PrincipalBase {
  kind: "agent";
  organizationId: string;
  grantId: string;
}

export interface ServicePrincipal extends PrincipalBase {
  kind: "service";
  organizationId: string;
  grantId: string;
}

export interface GuestPrincipal extends PrincipalBase {
  kind: "guest";
  grantId: string;
  resourceIds: string[];
}

export type AuthenticatedPrincipal =
  | HumanPrincipal
  | AgentPrincipal
  | ServicePrincipal
  | GuestPrincipal;

export type AuthenticationResult =
  | { status: "authenticated"; principal: AuthenticatedPrincipal }
  | { status: "invalid_credential" }
  | { status: "authority_unavailable" };

/** The wire response is untrusted until the consumer validates the principal. */
export type AuthenticationWireResult =
  | { status: "authenticated"; principal: unknown }
  | { status: "invalid_credential" }
  | { status: "authority_unavailable" };

export interface PrincipalExpectations {
  authority: string;
  audience: string;
  now?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function parsePrincipal(
  value: unknown,
  expectations: PrincipalExpectations,
): AuthenticatedPrincipal | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 ||
    value.authority !== expectations.authority ||
    value.audience !== expectations.audience ||
    !isNonEmptyString(value.subjectId) ||
    !isNonEmptyString(value.credentialId) ||
    !isStringArray(value.capabilities)
  ) {
    return null;
  }

  const expiry = value.expiresAt;
  const isValidFutureExpiry =
    isNonEmptyString(expiry) &&
    Number.isFinite(Date.parse(expiry)) &&
    Date.parse(expiry) > (expectations.now ?? Date.now());

  if (value.kind === "human") {
    if (!isNonEmptyString(value.organizationId) || !isNonEmptyString(value.membershipId)) {
      return null;
    }
    if (!isValidFutureExpiry) return null;
    return {
      version: 1,
      kind: "human",
      authority: value.authority,
      subjectId: value.subjectId,
      credentialId: value.credentialId,
      audience: value.audience,
      capabilities: [...value.capabilities],
      expiresAt: expiry,
      organizationId: value.organizationId,
      membershipId: value.membershipId,
    };
  }

  if (value.kind === "agent" || value.kind === "service") {
    if (!isNonEmptyString(value.organizationId) || !isNonEmptyString(value.grantId)) {
      return null;
    }
    if (!isValidFutureExpiry) return null;
    const base = {
      version: 1 as const,
      authority: value.authority,
      subjectId: value.subjectId,
      credentialId: value.credentialId,
      audience: value.audience,
      capabilities: [...value.capabilities],
      expiresAt: expiry,
      organizationId: value.organizationId,
      grantId: value.grantId,
    };
    return value.kind === "agent"
      ? { ...base, kind: "agent" }
      : { ...base, kind: "service" };
  }

  if (value.kind === "guest") {
    if (!isNonEmptyString(value.grantId) || !isStringArray(value.resourceIds)) {
      return null;
    }
    if (expiry !== null) return null;
    return {
      version: 1,
      kind: "guest",
      authority: value.authority,
      subjectId: value.subjectId,
      credentialId: value.credentialId,
      audience: value.audience,
      capabilities: [...value.capabilities],
      expiresAt: null,
      grantId: value.grantId,
      resourceIds: [...value.resourceIds],
    };
  }

  return null;
}

export function parseAuthenticationResult(value: unknown): AuthenticationWireResult | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "invalid_credential") return { status: "invalid_credential" };
  if (value.status === "authority_unavailable") return { status: "authority_unavailable" };
  if (value.status !== "authenticated") return null;
  return Object.hasOwn(value, "principal")
    ? { status: "authenticated", principal: value.principal }
    : null;
}

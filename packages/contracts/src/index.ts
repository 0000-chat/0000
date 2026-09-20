export interface PrincipalBase {
  version: 1;
  authority: string;
  subjectId: string;
  credentialId: string;
  audience: string;
  capabilities: string[];
}

export interface ExpiringPrincipalBase extends PrincipalBase {
  expiresAt: string;
}

export interface HumanPrincipal extends ExpiringPrincipalBase {
  kind: "human";
  organizationId: string;
  membershipId: string;
}

export interface AgentPrincipal extends ExpiringPrincipalBase {
  kind: "agent";
  organizationId: string;
  grantId: string;
}

export interface ServicePrincipal extends ExpiringPrincipalBase {
  kind: "service";
  organizationId: string;
  grantId: string;
}

export interface GuestPrincipal extends PrincipalBase {
  kind: "guest";
  /** Guest credentials remain valid while service-owned resource grants exist. */
  expiresAt: null;
  grantId: string;
  resourceIds: string[];
}

export type GuestGrantAssertion =
  | { kind: "owner"; storedOwnerId: string; permissionId?: string }
  | { kind: "participant"; permissionId?: string };

export type GuestOperationFailure =
  | { status: "invalid_guest_control" }
  | { status: "grant_denied" }
  | { status: "conflict" }
  | { status: "authority_unavailable" };

export interface GuestControlIdentity {
  guestId: string;
  authority: string;
  audience: string;
  purpose: "guest_control";
}

export interface GuestCreateSuccess extends GuestControlIdentity {
  bootstrapCredential: string;
}

export interface GuestResolveSuccess extends GuestControlIdentity {}

export interface GuestGrantSuccess {
  credential: string;
  credentialId: string;
  grantId: string;
  principal: GuestPrincipal;
}

export type GuestCreateResult =
  | ({ status: "success" } & GuestCreateSuccess)
  | GuestOperationFailure;

export type GuestResolveResult =
  | ({ status: "success" } & GuestResolveSuccess)
  | GuestOperationFailure;

export type GuestGrantResult =
  | { status: "success"; value: GuestGrantSuccess }
  | GuestOperationFailure;

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

function parseGuestOperationStatus(
  value: unknown,
): GuestOperationFailure | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (
    value.status === "invalid_guest_control" ||
    value.status === "grant_denied" ||
    value.status === "conflict" ||
    value.status === "authority_unavailable"
  ) {
    return { status: value.status };
  }
  return null;
}

function parseGuestControlIdentity(
  value: unknown,
  expectations: { authority: string; audience?: string },
): GuestControlIdentity | null {
  if (
    !isRecord(value) ||
    value.authority !== expectations.authority ||
    value.purpose !== "guest_control" ||
    !isNonEmptyString(value.guestId) ||
    !isNonEmptyString(value.audience)
  ) {
    return null;
  }
  return {
    guestId: value.guestId,
    authority: value.authority,
    audience: value.audience as string,
    purpose: "guest_control",
  };
}

export function parseGuestCreateResult(
  value: unknown,
  expectations: { authority: string; audience: string },
): GuestCreateResult | null {
  const failure = parseGuestOperationStatus(value);
  if (failure) return failure;
  if (!isRecord(value) || value.status !== "success") return null;
  const identity =
    value.audience === expectations.audience
      ? parseGuestControlIdentity(value, expectations)
      : null;
  if (!identity || !isNonEmptyString(value.bootstrapCredential)) return null;
  return {
    status: "success",
    ...identity,
    bootstrapCredential: value.bootstrapCredential,
  };
}

export function parseGuestResolveResult(
  value: unknown,
  expectations: { authority: string; audience: string },
): GuestResolveResult | null {
  const failure = parseGuestOperationStatus(value);
  if (failure) return failure;
  if (!isRecord(value) || value.status !== "success") return null;
  const identity =
    value.audience === expectations.audience
      ? parseGuestControlIdentity(value, expectations)
      : null;
  return identity ? { status: "success", ...identity } : null;
}

export function parseGuestGrantResult(
  value: unknown,
  expectations: PrincipalExpectations,
): GuestGrantResult | null {
  const failure = parseGuestOperationStatus(value);
  if (failure) return failure;
  if (!isRecord(value) || value.status !== "success") return null;
  if (
    !isNonEmptyString(value.credential) ||
    !isNonEmptyString(value.credentialId) ||
    !isNonEmptyString(value.grantId)
  ) {
    return null;
  }
  const principal = parsePrincipal(value.principal, expectations);
  if (!principal || principal.kind !== "guest") return null;
  if (
    principal.credentialId !== value.credentialId ||
    principal.grantId !== value.grantId
  ) {
    return null;
  }
  return {
    status: "success",
    value: {
      credential: value.credential,
      credentialId: value.credentialId,
      grantId: value.grantId,
      principal,
    },
  };
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
    if (
      !isNonEmptyString(value.organizationId) ||
      !isNonEmptyString(value.membershipId)
    ) {
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
    if (
      !isNonEmptyString(value.organizationId) ||
      !isNonEmptyString(value.grantId)
    ) {
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

export function parseAuthenticationResult(
  value: unknown,
): AuthenticationWireResult | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  if (value.status === "invalid_credential")
    return { status: "invalid_credential" };
  if (value.status === "authority_unavailable")
    return { status: "authority_unavailable" };
  if (value.status !== "authenticated") return null;
  return Object.hasOwn(value, "principal")
    ? { status: "authenticated", principal: value.principal }
    : null;
}

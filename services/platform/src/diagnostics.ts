export const PLATFORM_DIAGNOSTIC_EVENTS = [
  "platform.authentication.outcome",
  "platform.request.timed_out",
  "platform.provider.linked",
  "platform.provider.unlinked",
  "platform.session.signed_in",
  "platform.session.signed_out",
  "platform.organization.created",
  "platform.organization.updated",
  "platform.organization.member_added",
  "platform.organization.member_updated",
  "platform.organization.member_removed",
  "platform.organization.member_left",
  "platform.organization.lifecycle_changed",
  "platform.credential.created",
  "platform.credential.rotated",
  "platform.credential.revoked",
  "platform.agent.created",
  "platform.agent.updated",
  "platform.agent.grant_changed",
  "platform.agent.credential_created",
  "platform.agent.credential_rotated",
  "platform.agent.credential_revoked",
  "platform.oauth.installation_activated",
  "platform.oauth.installation_refreshed",
  "platform.oauth.installation_revoked",
  "platform.guest.bootstrap_created",
  "platform.guest.grant_renewed",
  "platform.guest.grant_revoked",
  "platform.library.diagnostic",
] as const;

export type PlatformDiagnosticEvent =
  (typeof PLATFORM_DIAGNOSTIC_EVENTS)[number];

export const PLATFORM_DIAGNOSTIC_OUTCOMES = [
  "success",
  "denied",
  "error",
  "timeout",
  "unavailable",
  "rate_limited",
] as const;

export type PlatformDiagnosticOutcome =
  (typeof PLATFORM_DIAGNOSTIC_OUTCOMES)[number];

export interface PlatformDiagnostic {
  readonly event: PlatformDiagnosticEvent;
  readonly outcome: PlatformDiagnosticOutcome;
  readonly serverTime: string;
  readonly correlationId: string;
  readonly principalId?: string;
  readonly serviceId?: string;
  readonly organizationId?: string;
  readonly resourceId?: string;
}

export interface PlatformDiagnosticIdentifiers {
  readonly principalId?: string;
  readonly serviceId?: string;
  readonly organizationId?: string;
  readonly resourceId?: string;
}

export interface PlatformDiagnosticDetails
  extends PlatformDiagnosticIdentifiers {
  readonly request?: Request;
}

export type PlatformDiagnosticSink = (event: PlatformDiagnostic) => void;

const requestCorrelations = new WeakMap<Request, string>();

function freshCorrelationId(): string {
  return crypto.randomUUID();
}

export function registerPlatformRequestCorrelation(request: Request): string {
  const existing = requestCorrelations.get(request);
  if (existing) return existing;
  const correlationId = freshCorrelationId();
  requestCorrelations.set(request, correlationId);
  return correlationId;
}

export function copyPlatformRequestCorrelation(
  source: Request,
  target: Request,
): string {
  const correlationId = registerPlatformRequestCorrelation(source);
  requestCorrelations.set(target, correlationId);
  return correlationId;
}

export function platformRequestCorrelation(
  request: Request | undefined,
): string {
  return request
    ? registerPlatformRequestCorrelation(request)
    : freshCorrelationId();
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function allowlistedIdentifiers(
  details: PlatformDiagnosticDetails | undefined,
): PlatformDiagnosticIdentifiers {
  if (!details) return {};
  return {
    ...(isNonEmptyIdentifier(details.principalId)
      ? { principalId: details.principalId }
      : {}),
    ...(isNonEmptyIdentifier(details.serviceId)
      ? { serviceId: details.serviceId }
      : {}),
    ...(isNonEmptyIdentifier(details.organizationId)
      ? { organizationId: details.organizationId }
      : {}),
    ...(isNonEmptyIdentifier(details.resourceId)
      ? { resourceId: details.resourceId }
      : {}),
  };
}

export function buildPlatformDiagnostic(
  event: PlatformDiagnosticEvent,
  outcome: PlatformDiagnosticOutcome,
  details?: PlatformDiagnosticDetails,
): PlatformDiagnostic {
  if (!PLATFORM_DIAGNOSTIC_EVENTS.includes(event)) {
    throw new Error("Unsupported Platform diagnostic event.");
  }
  if (!PLATFORM_DIAGNOSTIC_OUTCOMES.includes(outcome)) {
    throw new Error("Unsupported Platform diagnostic outcome.");
  }
  return {
    event,
    outcome,
    serverTime: new Date().toISOString(),
    correlationId: platformRequestCorrelation(details?.request),
    ...allowlistedIdentifiers(details),
  };
}

function defaultPlatformDiagnosticSink(event: PlatformDiagnostic): void {
  // This is the sole Platform diagnostic sink. Never pass library messages,
  // errors, request bodies, headers or credential material to it.
  console.log(JSON.stringify(event));
}

export function emitPlatformDiagnostic(
  event: PlatformDiagnosticEvent,
  outcome: PlatformDiagnosticOutcome,
  details?: PlatformDiagnosticDetails,
  sink: PlatformDiagnosticSink = defaultPlatformDiagnosticSink,
): void {
  try {
    sink(buildPlatformDiagnostic(event, outcome, details));
  } catch {
    // Diagnostics are best effort. A sink failure cannot change authorization,
    // commit state or the response already selected by the authority.
  }
}

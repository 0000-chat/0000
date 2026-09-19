import {
  createPlatformClient,
  createPlatformGuestClient,
} from "@0000/platform-client";
import type { AuthenticatedPrincipal } from "@0000/contracts";

import { ERROR_CODES, ProtocolError } from "./errors";

export const MSG_READ = "msg:read";
export const MSG_WRITE = "msg:write";
export const MSG_MANAGE = "msg:manage";
export const MSG_CLAIM = "msg:claim";
export const MSG_OPERATOR = "msg:operator";
export const MSG_PERMISSION_IDS = {
  owner: "msg-owner",
  public: "msg-public",
  management: "msg-management",
} as const;

export type AccessSource = "owner" | "public" | "management";

export interface ResourceLinkProof {
  readonly source: AccessSource;
  readonly storedOwnerId?: string;
}

export interface MsgRoomAuthPort {
  proveLink(input: {
    room: string;
    source: AccessSource;
    token?: string;
  }): Promise<ResourceLinkProof | null>;
  recordGrant(input: {
    room: string;
    guestId: string;
    source: AccessSource;
    capabilities: readonly string[];
    grantId?: string;
  }): Promise<void>;
  checkGrant(input: {
    room: string;
    guestId: string;
    source: AccessSource;
    action: "read" | "write" | "manage";
    grantId?: string;
  }): Promise<boolean>;
  findGrant(input: {
    room: string;
    guestId: string;
    source?: AccessSource;
    grantId?: string;
  }): Promise<{ source: AccessSource; grantId?: string; capabilities: readonly string[]; active: boolean } | null>;
}

export interface MsgAuthConfig {
  readonly baseUrl: string;
  readonly authority: string;
  readonly audience: string;
  readonly guestGrantIssuer: string;
  readonly serviceVerifier: string;
  readonly operatorAllowlist?: readonly OperatorAllowlistEntry[];
  readonly fetch?: typeof fetch;
}

export interface OperatorAllowlistEntry {
  readonly kind: "human" | "agent";
  readonly subjectId: string;
  readonly organizationId: string;
}

export interface GuestControl {
  readonly bootstrapCredential: string;
  readonly guestId: string;
  readonly setCookies: readonly string[];
}

export interface ResourceAuthorization {
  readonly context: MsgAuthContext;
  readonly setCookies: readonly string[];
}

export interface GuestAuthContext {
  readonly kind: "guest";
  readonly credential: string;
  readonly guestId: string;
  readonly grantId?: string;
  readonly source: AccessSource;
}

export interface OrganizationAuthContext {
  readonly kind: "organization";
  readonly credential: string;
  readonly subjectId: string;
  readonly organizationId: string;
  readonly capabilities: readonly string[];
  readonly guestId?: string;
  readonly source: "organization";
}

export interface ClaimAuthContext {
  readonly kind: "claim";
  readonly credential: string;
  readonly subjectId: string;
  readonly organizationId: string;
  readonly capabilities: readonly string[];
  readonly guestId: string;
  readonly source: "claim";
}

export type MsgAuthContext = GuestAuthContext | OrganizationAuthContext | ClaimAuthContext;

export interface ClaimAuthorization extends ResourceAuthorization {
  readonly context: ClaimAuthContext;
}

export type OperatorAuthorization =
  | { readonly status: "authorized"; readonly principal: AuthenticatedPrincipal }
  | { readonly status: "denied"; readonly response: Response };

export interface MsgAuthenticator {
  control(request: Request): Promise<GuestControl>;
  authorizeOwner(request: Request, input: { room: string; storedOwnerId: string; grantId?: string }, control?: GuestControl): Promise<ResourceAuthorization>;
  authorizeClaim(request: Request): Promise<ClaimAuthorization>;
  authorizeOrganizationResource(request: Request, input: { room: string; action: "read" | "write" | "manage" }): Promise<ResourceAuthorization>;
  authorizeResource(request: Request, input: {
    room: string;
    source: AccessSource;
    token?: string;
    action: "read" | "write" | "manage";
    /** Explicitly replace a stale resource cookie after rechecking the link. */
    recover?: boolean;
  }): Promise<ResourceAuthorization>;
  authorizeOperator(request: Request): Promise<OperatorAuthorization>;
}

const CONTROL_COOKIE = "msg_guest_control";
const RESOURCE_COOKIE = "msg_resource";
const MANAGEMENT_COOKIE = "msg_management";

export function createMsgAuthenticator(
  config: MsgAuthConfig,
  rooms: MsgRoomAuthPort,
): MsgAuthenticator {
  const guestClient = createPlatformGuestClient({
    baseUrl: config.baseUrl,
    authority: config.authority,
    audience: config.audience,
    guestGrantIssuer: config.guestGrantIssuer,
    fetch: config.fetch,
  });
  const platformClient = createPlatformClient({
    baseUrl: config.baseUrl,
    authority: config.authority,
    audience: config.audience,
    serviceVerifier: config.serviceVerifier,
    fetch: config.fetch,
  });

  return {
    async control(request) {
      const cookies = parseCookies(request.headers.get("cookie"));
      const presented = cookies.get(CONTROL_COOKIE);
      if (presented !== undefined) {
        const resolved = await guestClient.resolveGuestControl(presented);
        if (resolved.status === "invalid_guest_control") throw authError("The guest control cookie is invalid.", 401);
        if (resolved.status !== "success") throw authorityError();
        return { bootstrapCredential: presented, guestId: resolved.guestId, setCookies: [] };
      }
      const created = await guestClient.createGuest();
      if (created.status !== "success") throw authorityError();
      return {
        bootstrapCredential: created.bootstrapCredential,
        guestId: created.guestId,
        setCookies: [serializeCookie(CONTROL_COOKIE, created.bootstrapCredential, "/")],
      };
    },

    async authorizeOwner(request, input, existingControl) {
      const control = existingControl ?? await this.control(request);
      if (control.guestId !== input.storedOwnerId) throw authError("The creator control is not the stored room owner.", 403);
      const local = await rooms.findGrant({ room: input.room, guestId: control.guestId, source: "owner", ...(input.grantId ? { grantId: input.grantId } : {}) });
      if (local && !local.active) throw authError("The creator permission is no longer valid.", 403);
      if (!local) {
        const proof = await rooms.proveLink({ room: input.room, source: "owner" });
        if (!proof || proof.storedOwnerId !== undefined && proof.storedOwnerId !== input.storedOwnerId) throw authError("The creator permission is no longer valid.", 403);
      }
      if (input.grantId && (!local || local.grantId !== input.grantId || !local.capabilities.includes(MSG_READ) || !local.capabilities.includes(MSG_WRITE))) {
        throw authError("The creator permission is no longer valid.", 403);
      }
      const grant = local?.grantId
        ? await guestClient.renewGuestGrant({
          bootstrapCredential: control.bootstrapCredential,
          grantId: local.grantId,
          resourceId: input.room,
          capabilities: [MSG_READ, MSG_WRITE],
          assertion: { kind: "owner", storedOwnerId: input.storedOwnerId, permissionId: MSG_PERMISSION_IDS.owner },
        })
        : await guestClient.attestGuestGrant({
          bootstrapCredential: control.bootstrapCredential,
          resourceId: input.room,
          capabilities: [MSG_READ, MSG_WRITE],
          assertion: { kind: "owner", storedOwnerId: input.storedOwnerId, permissionId: MSG_PERMISSION_IDS.owner },
        });
      if (grant.status === "authority_unavailable") throw authorityError();
      if (grant.status !== "success") throw authError("The creator grant could not be issued.", 403);
      await rooms.recordGrant({ room: input.room, guestId: control.guestId, source: "owner", capabilities: [MSG_READ, MSG_WRITE], grantId: grant.value.grantId });
      return {
        context: { kind: "guest", credential: grant.value.credential, guestId: control.guestId, grantId: grant.value.grantId, source: "owner" },
        setCookies: [
          ...(existingControl ? [] : control.setCookies),
          serializeCookie(RESOURCE_COOKIE, grant.value.credential, `/${input.room}`),
        ],
      };
    },

    async authorizeClaim(request) {
      const credential = requireBearer(request);
      const authentication = await platformClient.authenticate(credential);
      if (authentication.status === "invalid_credential") throw authError("The claim credential is invalid.", 401);
      if (authentication.status === "authority_unavailable") throw authorityError();
      const principal = authentication.principal;
      if (principal.kind !== "human" || !principal.capabilities.includes(MSG_CLAIM)) {
        throw authError("The claimant is not authorized for msg ownership claims.", 403);
      }
      const control = await existingControl(request, guestClient);
      return {
        context: {
          kind: "claim",
          credential,
          subjectId: principal.subjectId,
          organizationId: principal.organizationId,
          capabilities: principal.capabilities,
          guestId: control.guestId,
          source: "claim",
        },
        setCookies: control.setCookies,
      };
    },

    async authorizeOrganizationResource(request, input) {
      const credential = requireBearer(request);
      const authentication = await platformClient.authenticate(credential);
      if (authentication.status === "invalid_credential") throw authError("The organization credential is invalid.", 401);
      if (authentication.status === "authority_unavailable") throw authorityError();
      const principal = authentication.principal;
      const capability = input.action === "read" ? MSG_READ : input.action === "write" ? MSG_WRITE : MSG_MANAGE;
      if (principal.kind === "guest" || !principal.capabilities.includes(capability)) {
        throw authError("The organization credential is not authorized for this request.", 403);
      }
      return {
        context: {
          kind: "organization",
          credential,
          subjectId: principal.subjectId,
          organizationId: principal.organizationId,
          capabilities: principal.capabilities,
          source: "organization",
        },
        setCookies: [],
      };
    },

    async authorizeResource(request, input) {
      if (request.headers.has("authorization")) return this.authorizeOrganizationResource(request, input);
      const control = await this.control(request);
      const cookies = parseCookies(request.headers.get("cookie"));
      const resourceCookie = cookies.get(input.source === "management" ? MANAGEMENT_COOKIE : RESOURCE_COOKIE);
      // A public room's read credential is also the browser/CLI's durable
      // participant credential for subsequent posts.  The link proof still
      // gates issuance, while the DO ACL checks the requested action.
      const defaultCapabilities = input.source === "public"
        ? [MSG_READ, MSG_WRITE]
        : input.action === "manage"
          ? [MSG_MANAGE]
          : [MSG_READ];
      if (resourceCookie !== undefined && !input.recover) {
        await rooms.checkGrant({ room: input.room, guestId: control.guestId, source: input.source, action: input.action });
        const authentication = await platformClient.authenticate(resourceCookie);
        if (authentication.status === "invalid_credential") throw authError("The resource credential is invalid.", 401);
        if (authentication.status === "authority_unavailable") throw authorityError();
        const principal = authentication.principal;
        const requiredCapabilities = input.source === "public" && input.action === "read" ? [MSG_READ] : defaultCapabilities;
        if (principal.kind !== "guest" || principal.subjectId !== control.guestId || !principal.resourceIds.includes(input.room) || requiredCapabilities.some((capability) => !principal.capabilities.includes(capability))) {
          throw authError("The resource credential is not valid for this request.", 403);
        }
        const local = await rooms.findGrant({ room: input.room, guestId: control.guestId, grantId: principal.grantId });
        const effectiveSource = input.source === "public" && local?.source === "owner" ? "owner" : input.source;
        if (!local || !local.active || local.source !== effectiveSource || !(await rooms.checkGrant({ room: input.room, guestId: control.guestId, source: effectiveSource, action: input.action, grantId: principal.grantId }))) {
          throw authError("The resource permission is no longer valid.", 403);
        }
        return {
          context: { kind: "guest", credential: resourceCookie, guestId: control.guestId, grantId: principal.grantId, source: effectiveSource },
          setCookies: control.setCookies,
        };
      }

      const proof = await rooms.proveLink({ room: input.room, source: input.source, token: input.token });
      if (!proof) throw authError("The requested resource was not found.", 404);
      const local = await rooms.findGrant({ room: input.room, guestId: control.guestId, source: input.source });
      if (local && !local.active) throw authError("The resource permission is no longer valid.", 403);
      // A previously issued read-only public grant can still read the room.
      // A fresh public link keeps the usual read/write participant grant, and
      // any write request still requires both capabilities.
      const needed = input.source === "public" && input.action === "read" && local
        ? [MSG_READ]
        : defaultCapabilities;
      const assertion = { kind: "participant" as const, permissionId: MSG_PERMISSION_IDS[input.source] };
      const grant = local?.grantId
        ? await guestClient.renewGuestGrant({
          bootstrapCredential: control.bootstrapCredential,
          grantId: local.grantId,
          resourceId: input.room,
          capabilities: needed,
          assertion,
        })
        : await guestClient.attestGuestGrant({
          bootstrapCredential: control.bootstrapCredential,
          resourceId: input.room,
          capabilities: needed,
          assertion,
        });
      if (grant.status === "authority_unavailable") throw authorityError();
      if (grant.status !== "success") throw authError("The resource permission is not valid.", 403);
      await rooms.recordGrant({ room: input.room, guestId: control.guestId, source: input.source, capabilities: needed, grantId: grant.value.grantId });
      const resourceCookiePath = input.source === "management" ? `/manage/${input.room}` : `/${input.room}`;
      const resourceCookieName = input.source === "management" ? MANAGEMENT_COOKIE : RESOURCE_COOKIE;
      return {
        context: { kind: "guest", credential: grant.value.credential, guestId: control.guestId, grantId: grant.value.grantId, source: input.source },
        setCookies: [...control.setCookies, serializeCookie(resourceCookieName, grant.value.credential, resourceCookiePath)],
      };
    },

    async authorizeOperator(request) {
      const authorization = request.headers.get("authorization");
      const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
      if (!match) return { status: "denied", response: operatorResponse(401, "Operator authentication is required.") };
      const authentication = await platformClient.authenticate(match[1]!);
      if (authentication.status === "invalid_credential") return { status: "denied", response: operatorResponse(401, "Operator authentication is invalid.") };
      if (authentication.status === "authority_unavailable") return { status: "denied", response: operatorResponse(503, "The identity authority is temporarily unavailable.") };
      const principal = authentication.principal;
      if ((principal.kind !== "human" && principal.kind !== "agent") || !principal.capabilities.includes(MSG_OPERATOR)) {
        return { status: "denied", response: operatorResponse(403, "The operator capability is not granted.") };
      }
      const allowed = config.operatorAllowlist?.some((entry) => entry.kind === principal.kind && entry.subjectId === principal.subjectId && entry.organizationId === principal.organizationId) ?? false;
      return allowed
        ? { status: "authorized", principal }
        : { status: "denied", response: operatorResponse(403, "The operator is not allowlisted for msg.") };
    },
  };
}

/** Production uses this fail-closed adapter when deployment configuration is incomplete. */
export function unavailableMsgAuthenticator(): MsgAuthenticator {
  const unavailable = async (): Promise<never> => { throw authorityError(); };
  return {
    control: unavailable,
    authorizeOwner: unavailable,
    authorizeClaim: unavailable,
    authorizeOrganizationResource: unavailable,
    authorizeResource: unavailable,
    async authorizeOperator() { return { status: "denied", response: operatorResponse(503, "The identity authority is temporarily unavailable.") }; },
  };
}

export function parseOperatorAllowlist(value: string | undefined): OperatorAllowlistEntry[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MSG_OPERATOR_ALLOWLIST must be valid JSON."); }
  if (!Array.isArray(parsed)) throw new Error("MSG_OPERATOR_ALLOWLIST must be an array.");
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("MSG_OPERATOR_ALLOWLIST contains an invalid entry.");
    const value = entry as Record<string, unknown>;
    if ((value.kind !== "human" && value.kind !== "agent") || typeof value.subjectId !== "string" || !value.subjectId || typeof value.organizationId !== "string" || !value.organizationId) throw new Error("MSG_OPERATOR_ALLOWLIST contains an invalid entry.");
    return { kind: value.kind, subjectId: value.subjectId, organizationId: value.organizationId } as OperatorAllowlistEntry;
  });
}

export function parseCookies(header: string | null): Map<string, string> {
  const values = new Map<string, string>();
  if (!header) return values;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    let value: string;
    try { value = decodeURIComponent(item.slice(separator + 1).trim()); } catch { throw authError("The request contains an invalid cookie.", 400); }
    if (!name || values.has(name)) throw authError("The request contains ambiguous cookies.", 400);
    values.set(name, value);
  }
  return values;
}

export function serializeCookie(name: string, value: string, path: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
}

function authError(message: string, status: number): ProtocolError {
  return new ProtocolError(status === 404 ? ERROR_CODES.notFound : status === 403 ? ERROR_CODES.forbidden : ERROR_CODES.invalidBody, message, status);
}

function authorityError(): ProtocolError {
  return new ProtocolError(ERROR_CODES.serviceUnavailable, "The identity authority is temporarily unavailable.", 503);
}

function requireBearer(request: Request): string {
  const value = request.headers.get("authorization");
  const match = /^Bearer ([^\s]+)$/u.exec(value ?? "");
  if (!match) throw authError("An explicit Bearer credential is required.", 401);
  return match[1]!;
}

async function existingControl(request: Request, guestClient: ReturnType<typeof createPlatformGuestClient>): Promise<GuestControl> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const presented = cookies.get(CONTROL_COOKIE);
  if (presented === undefined) throw authError("The guest control cookie is required.", 403);
  const resolved = await guestClient.resolveGuestControl(presented);
  if (resolved.status === "invalid_guest_control") throw authError("The guest control cookie is invalid.", 401);
  if (resolved.status !== "success") throw authorityError();
  return { bootstrapCredential: presented, guestId: resolved.guestId, setCookies: [] };
}

function operatorResponse(status: number, message: string): Response {
  return Response.json({ error: { code: status === 503 ? ERROR_CODES.serviceUnavailable : status === 403 ? ERROR_CODES.forbidden : "unauthorized", message } }, { status });
}

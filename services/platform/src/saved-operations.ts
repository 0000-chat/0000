import {
  parseAuthenticationResult,
  parsePrincipal,
  parseSavedOperationAuthorization,
  type AgentPrincipal,
  type HumanPrincipal,
  type SavedOperationAuthorization,
} from "@0000/contracts";
import {
  hashOpaque,
  validCapability,
  type ServiceRegistration,
} from "./platform-state";

type Actor = HumanPrincipal | AgentPrincipal;
type Lineage = { kind: "session" | "installation" | "grant"; id: string };
interface SavedOperationRow {
  id: string;
  authority: string;
  service_id: string;
  subject_id: string;
  organization_id: string;
  audience: string;
  operation_id: string;
  capability: string;
  credential_id: string;
  lineage_kind: Lineage["kind"];
  lineage_id: string;
}

function descriptor(row: SavedOperationRow): SavedOperationAuthorization {
  return {
    id: row.id,
    authority: row.authority,
    subjectId: row.subject_id,
    organizationId: row.organization_id,
    audience: row.audience,
    operationId: row.operation_id,
    capability: row.capability,
  };
}

function matches(
  row: SavedOperationRow,
  value: SavedOperationAuthorization,
): boolean {
  const stored = descriptor(row);
  return (
    stored.id === value.id &&
    stored.authority === value.authority &&
    stored.subjectId === value.subjectId &&
    stored.organizationId === value.organizationId &&
    stored.audience === value.audience &&
    stored.operationId === value.operationId &&
    stored.capability === value.capability
  );
}

/** Derive lineage only from native Platform state, never caller-supplied IDs. */
async function currentLineage(
  database: D1DatabaseSession,
  actor: Actor,
): Promise<Lineage | null> {
  const row = await database
    .prepare(
      `SELECT credential.oauth_installation_id, installation.purpose,
            flow.session_id, installation.user_id
     FROM platform_credential AS credential
     LEFT JOIN platform_oauth_installation AS installation
       ON installation.id = credential.oauth_installation_id
     LEFT JOIN platform_oauth_flow AS flow
       ON flow.installation_id = installation.id AND flow.status = 'activated'
     WHERE credential.id = ?`,
    )
    .bind(actor.credentialId)
    .first<{
      oauth_installation_id: string | null;
      purpose: string | null;
      session_id: string | null;
      user_id: string | null;
    }>();
  if (!row) return null;
  if (actor.kind === "human") {
    if (
      row.purpose !== "first_party_browser" ||
      !row.session_id ||
      row.user_id !== actor.subjectId
    )
      return null;
    const session = await database
      .prepare(
        `SELECT id FROM session WHERE id = ? AND userId = ? AND expiresAt > ?`,
      )
      .bind(row.session_id, actor.subjectId, Date.now())
      .first<{ id: string }>();
    return session ? { kind: "session", id: session.id } : null;
  }
  if (row.oauth_installation_id) {
    return row.purpose === "personal_harness"
      ? { kind: "installation", id: row.oauth_installation_id }
      : null;
  }
  return { kind: "grant", id: actor.grantId };
}

const denied = () => Response.json({ status: "denied" }, { status: 403 });
const unavailable = () =>
  Response.json({ status: "authority_unavailable" }, { status: 503 });

export async function savedOperationRequest(input: {
  request: Request;
  database: D1DatabaseSession;
  service: ServiceRegistration;
  authority: string;
  capture: boolean;
  verifyHash: (hash: string) => Promise<Response>;
}): Promise<Response> {
  const { request, database, service, authority, capture, verifyHash } = input;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return denied();
  }
  if (!body || typeof body !== "object") return denied();

  let row: SavedOperationRow | null = null;
  let credentialHash: string;
  let operationId: string;
  let capability: string;
  if (capture) {
    if (
      !("credential" in body) ||
      typeof body.credential !== "string" ||
      !body.credential ||
      !("operationId" in body) ||
      typeof body.operationId !== "string" ||
      !body.operationId ||
      body.operationId.length > 256 ||
      !("capability" in body) ||
      !validCapability(body.capability)
    )
      return denied();
    credentialHash = await hashOpaque(body.credential);
    operationId = body.operationId;
    capability = body.capability;
  } else {
    const authorization = parseSavedOperationAuthorization(body);
    if (
      !authorization ||
      authorization.authority !== authority ||
      authorization.audience !== service.audience
    )
      return denied();
    row = await database
      .prepare(
        "SELECT * FROM platform_saved_operation WHERE id = ? AND service_id = ?",
      )
      .bind(authorization.id, service.serviceId)
      .first<SavedOperationRow>();
    if (!row || !matches(row, authorization)) return denied();
    const credential = await database
      .prepare("SELECT credential_hash FROM platform_credential WHERE id = ?")
      .bind(row.credential_id)
      .first<{ credential_hash: string }>();
    if (!credential) return denied();
    credentialHash = credential.credential_hash;
    operationId = row.operation_id;
    capability = row.capability;
  }
  if (!service.allowedCapabilities.includes(capability)) return denied();

  // Use precisely the normal current-state verifier; an ID is not authentication.
  const response = await verifyHash(credentialHash);
  if (response.status === 401) return denied();
  if (response.status !== 200) return unavailable();
  const verified = parseAuthenticationResult(await response.json());
  if (verified?.status !== "authenticated") return unavailable();
  const actor = parsePrincipal(verified.principal, {
    authority,
    audience: service.audience,
  });
  if (
    !actor ||
    (actor.kind !== "human" && actor.kind !== "agent") ||
    !actor.capabilities.includes(capability)
  )
    return denied();
  const lineage = await currentLineage(database, actor);
  if (!lineage) return denied();

  if (capture) {
    await database
      .prepare(
        `INSERT INTO platform_saved_operation
       (id, authority, service_id, subject_id, organization_id, audience, operation_id,
        capability, credential_id, lineage_kind, lineage_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (service_id, operation_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        authority,
        service.serviceId,
        actor.subjectId,
        actor.organizationId,
        service.audience,
        operationId,
        capability,
        actor.credentialId,
        lineage.kind,
        lineage.id,
        Date.now(),
      )
      .run();
    row = await database
      .prepare(
        "SELECT * FROM platform_saved_operation WHERE service_id = ? AND operation_id = ?",
      )
      .bind(service.serviceId, operationId)
      .first<SavedOperationRow>();
  }
  if (!row) return unavailable();
  if (
    row.authority !== authority ||
    row.audience !== service.audience ||
    row.subject_id !== actor.subjectId ||
    row.organization_id !== actor.organizationId ||
    row.capability !== capability ||
    row.credential_id !== actor.credentialId ||
    row.lineage_kind !== lineage.kind ||
    row.lineage_id !== lineage.id
  )
    return denied();
  return Response.json(
    capture
      ? { status: "allowed", authorization: descriptor(row) }
      : { status: "allowed", principal: actor },
  );
}

import {
  createAgent,
  createOrNarrowAgentGrant,
  issueAgentCredential,
} from "../../../src/agent-state";
import { ensureDefaultOrganization } from "../../../src/platform-state";
import type { ServiceRegistration } from "../../../src/platform-state";

/** Seed native authority through Platform helpers; all verification uses Worker HTTP. */
export async function provisionSavedAgent(
  database: D1Database,
  service: ServiceRegistration,
) {
  const userId = crypto.randomUUID();
  await database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
     VALUES (?, 'Saved actor owner', ?, 1, ?, ?)`,
    )
    .bind(userId, `${userId}@example.test`, Date.now(), Date.now())
    .run();
  const organization = await ensureDefaultOrganization(database, {
    id: userId,
    name: "Saved actor owner",
  });
  const agent = await createAgent(database, {
    actorUserId: userId,
    organizationId: organization.organizationId,
    name: "Saved actor",
  });
  if (!agent) throw new Error("agent fixture creation failed");
  const grant = await createOrNarrowAgentGrant(
    database.withSession("first-primary"),
    {
      actorUserId: userId,
      organizationId: organization.organizationId,
      agentId: agent.id,
      service,
      capabilities: service.allowedCapabilities,
    },
  );
  if (grant.status !== "created") throw new Error("agent fixture grant failed");
  const credential = await issueAgentCredential(database, {
    actorUserId: userId,
    organizationId: organization.organizationId,
    agentId: agent.id,
    grantId: grant.grant.id,
    service,
    capabilities: service.allowedCapabilities,
    expiresAt: Date.now() + 3_600_000,
  });
  return {
    userId,
    ...organization,
    agentId: agent.id,
    grantId: grant.grant.id,
    ...credential,
  };
}

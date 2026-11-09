import platform from "../../../platform/src/worker.ts";
import { registerTestService } from "../../../platform/worker/test/fixtures/provision.ts";
import {
  createAgent,
  createOrNarrowAgentGrant,
  issueAgentCredential,
} from "../../../platform/src/agent-state.ts";
import { provisionHuman } from "./human.mjs";

// Test-only provisioning boundary, never included in a deployment entry point.
export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname !== "/__fixture/seed")
      return platform.fetch(request, env, context);
    const service = await registerTestService(env.IDENTITY_DB, {
      serviceId: "integrated-communicator",
      audience: "https://communicator.integrated.test",
      verifier: "integrated-local-service-verifier",
      guestGrantIssuer: "integrated-local-guest-issuer",
      allowedCapabilities: [
        "conversation.read",
        "message.send",
        "receipt.send",
        "connection.read",
        "connection.manage",
        "group.manage",
        "group.create",
        "directory.read",
        "directory.manage",
        "webhook.manage",
        "retention.manage",
        "ingestion.write",
        "outbound.claim",
      ],
    });
    const human = await provisionHuman(env, context, service);
    const managed = await createAgent(env.IDENTITY_DB, {
      actorUserId: human.userId,
      organizationId: human.organizationId,
      name: "Integrated managed actor",
    });
    const managedGrant = await createOrNarrowAgentGrant(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: human.userId,
        organizationId: human.organizationId,
        agentId: managed.id,
        service,
        capabilities: service.allowedCapabilities,
      },
    );
    const managedCredential = await issueAgentCredential(env.IDENTITY_DB, {
      actorUserId: human.userId,
      organizationId: human.organizationId,
      agentId: managed.id,
      grantId: managedGrant.grant.id,
      service,
      capabilities: service.allowedCapabilities,
      expiresAt: Date.now() + 3_600_000,
    });
    const actor = {
      ...managedCredential,
      userId: human.userId,
      organizationId: human.organizationId,
      agentId: managed.id,
      grantId: managedGrant.grant.id,
    };
    const gateway = await createAgent(env.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      name: "Integrated gateway",
      kind: "service",
    });
    const grant = await createOrNarrowAgentGrant(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        agentId: gateway.id,
        service,
        capabilities: ["ingestion.write", "outbound.claim"],
        kind: "service",
      },
    );
    const credential = await issueAgentCredential(env.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      agentId: gateway.id,
      grantId: grant.grant.id,
      service,
      capabilities: ["ingestion.write", "outbound.claim"],
      kind: "service",
      expiresAt: Date.now() + 3_600_000,
    });
    return Response.json({
      actor,
      human,
      gateway: { ...credential, agentId: gateway.id, grantId: grant.grant.id },
    });
  },
};

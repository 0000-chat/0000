import platform from "../../../../../../platform/src/worker.ts";
import { registerTestService } from "../../../../../../platform/worker/test/fixtures/provision.ts";
import { provisionSavedAgent } from "../../../../../../platform/worker/test/fixtures/saved-agent.ts";
import {
  createAgent,
  createOrNarrowAgentGrant,
  issueAgentCredential,
} from "../../../../../../platform/src/agent-state.ts";

// Local-only composition entry. This file is never part of a deployed Worker.
export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname !== "/__fixture/seed")
      return platform.fetch(request, env, context);
    const registration = {
      serviceId: "saved-send-communicator",
      audience: "https://communicator.saved.test",
      verifier: "saved-send-test-only-service-verifier",
      guestGrantIssuer: "saved-send-test-only-guest-issuer",
      allowedCapabilities: ["message.send", "outbound.claim"],
    };
    const registered = await env.IDENTITY_DB.prepare(
      "SELECT service_id FROM platform_service WHERE service_id = ?",
    )
      .bind(registration.serviceId)
      .first();
    const service = registered
      ? registration
      : await registerTestService(env.IDENTITY_DB, registration);
    const actor = await provisionSavedAgent(env.IDENTITY_DB, service);
    const gateway = await createAgent(env.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      name: "Controlled gateway",
      kind: "service",
    });
    const grant = await createOrNarrowAgentGrant(
      env.IDENTITY_DB.withSession("first-primary"),
      {
        actorUserId: actor.userId,
        organizationId: actor.organizationId,
        agentId: gateway.id,
        service,
        capabilities: ["outbound.claim"],
        kind: "service",
      },
    );
    const credential = await issueAgentCredential(env.IDENTITY_DB, {
      actorUserId: actor.userId,
      organizationId: actor.organizationId,
      agentId: gateway.id,
      grantId: grant.grant.id,
      service,
      capabilities: ["outbound.claim"],
      kind: "service",
      expiresAt: Date.now() + 3_600_000,
    });
    return Response.json({
      actor,
      gateway: { ...credential, agentId: gateway.id, grantId: grant.grant.id },
      service,
    });
  },
};

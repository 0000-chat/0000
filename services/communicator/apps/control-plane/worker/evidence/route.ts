import {
  OutboundEvidenceInputSchema,
  ProviderEvidenceObservationSchema,
  TimestampSchema,
  type OutboundDispatch,
} from "@communicator/contracts";
import type { Handler } from "hono";
import { z } from "zod";
import type { IngestionAuthorizationVariables } from "../auth/ingestion-middleware";
import { gatewayFetchFromEnv } from "../gateway/private-fetch";
import { getTenantProjection } from "../projection/routing";
import { ProjectionError } from "../projection/errors";
import { readAuthorizedMessageRemoval } from "../removals/service";

const responseSchema = z
  .object({
    schema_version: z.literal(1),
    tenant_id: z.string(),
    account_id: z.string(),
    connection_id: z.string(),
    session_generation: TimestampSchema,
    conversation_id: z.string(),
    transaction_id: z.string(),
    request_digest: z.string(),
    projection_generation: z.number().int().positive(),
    evidence_id: z.string().min(1).max(200),
    source: z.enum(["bridge", "provider"]),
    status: z.enum(["accepted", "delivered", "uncertain"]),
    reason: z.enum([
      "bridge_reported_success",
      "bridge_reported_dm_delivery",
      "bridge_pending",
      "bridge_fail_retriable",
      "bridge_fail_permanent",
    ]),
    observed_at: TimestampSchema,
    remote_echo_id: z.string().min(1).max(200),
    provider_read: z.literal("unsupported"),
  })
  .strict();

async function boundedJson(
  body: ReadableStream<Uint8Array> | null,
): Promise<unknown> {
  if (body === null) throw new Error("invalid");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Error("too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

const routeSchema = z.object({
  gateway_route_id: z.string(),
  bridge_instance_id: z.string(),
  matrix_user_id: z.string(),
  matrix_room_namespace: z.string(),
  session_generation: z.string(),
  route_generation: z.string(),
});

async function currentRoute(
  env: Cloudflare.Env,
  serviceId: string,
  dispatch: OutboundDispatch,
) {
  const row = await env.CONTROL_DB.withSession("first-primary")
    .prepare(`
    SELECT cr.gateway_route_id, cr.bridge_instance_id, cr.matrix_user_id,
      cr.matrix_room_namespace, c.updated_at AS session_generation, cr.updated_at AS route_generation
    FROM connections c JOIN connection_accounts ca ON ca.connection_id = c.id
    JOIN connection_routes cr ON cr.connection_id = c.id
    JOIN gateway_routes gr ON gr.id = cr.gateway_route_id
    JOIN principals p ON p.id = gr.service_principal_id
    JOIN tenants t ON t.id = c.tenant_id
    WHERE c.tenant_id = ? AND c.id = ? AND c.identity_id = ?
      AND ca.account_id = ? AND ca.status = 'active' AND t.status = 'active'
      AND c.status IN ('connected','syncing','ready')
      AND p.principal_type = 'service' AND p.status = 'active' AND p.revoked_at IS NULL
      AND gr.status = 'active' AND gr.service_principal_id = ? LIMIT 1
  `)
    .bind(
      dispatch.tenant_id,
      dispatch.connection_id,
      dispatch.resource_identity_id,
      dispatch.account_id,
      serviceId,
    )
    .first();
  const parsed = routeSchema.safeParse(row);
  const saved = dispatch.authority?.saved;
  if (!parsed.success || saved === undefined) return false;
  if (
    (await readAuthorizedMessageRemoval(env.CONTROL_DB, {
      tenantId: dispatch.tenant_id,
      messageId: dispatch.message_id,
      accountId: dispatch.account_id,
      conversationId: dispatch.conversation_id,
    })) !== null
  )
    return false;
  return (
    parsed.data.session_generation === saved.session_generation &&
    parsed.data.route_generation === saved.route_generation &&
    parsed.data.gateway_route_id === saved.route.gateway_route_id &&
    parsed.data.bridge_instance_id === saved.route.bridge_instance_id &&
    parsed.data.matrix_user_id === saved.route.matrix_user_id &&
    parsed.data.matrix_room_namespace === saved.route.matrix_room_namespace
  );
}

/** The caller selects an event ID, never a claimed status or a gateway URL. */
export const providerEvidenceHandler: Handler<{
  Bindings: Cloudflare.Env;
  Variables: IngestionAuthorizationVariables;
}> = async (context) => {
  const fail = (status: 400 | 403 | 409 | 422 | 503, error: string) =>
    context.json({ error }, status, { "Cache-Control": "no-store" });
  let input: z.infer<typeof ProviderEvidenceObservationSchema>;
  try {
    input = ProviderEvidenceObservationSchema.parse(
      await boundedJson(context.req.raw.body),
    );
  } catch {
    return fail(400, "provider_evidence_invalid");
  }
  try {
    const projection = getTenantProjection(context.env, input.tenant_id);
    const target = await projection.getProviderEvidenceTarget(input);
    const saved = target.authority?.saved;
    const service = context.get("ingestionAuthorization").service_principal_id;
    if (
      saved === undefined ||
      !(await currentRoute(context.env, service, target))
    )
      return fail(403, "provider_evidence_scope_mismatch");
    const runtime = context.env as Cloudflare.Env & {
      CONNECTION_GATEWAY_URL?: string;
      CONNECTION_GATEWAY_TOKEN?: string;
    };
    if (
      !runtime.CONNECTION_GATEWAY_URL ||
      !runtime.CONNECTION_GATEWAY_TOKEN ||
      runtime.CONNECTION_GATEWAY_TOKEN.length < 16
    )
      return fail(503, "provider_evidence_unavailable");
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    let response: Response;
    let value: z.infer<typeof responseSchema>;
    try {
      response = await gatewayFetchFromEnv(context.env)(
        `${runtime.CONNECTION_GATEWAY_URL.replace(/\/$/u, "")}/v1/outbound/evidence`,
        {
          method: "POST",
          signal: abort.signal,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${runtime.CONNECTION_GATEWAY_TOKEN}`,
            "content-type": "application/json",
            "x-request-id": crypto.randomUUID(),
            "idempotency-key": input.observation_event_id,
          },
          body: JSON.stringify({
            schema_version: 1,
            tenant_id: input.tenant_id,
            account_id: target.account_id,
            connection_id: target.connection_id,
            identity_id: target.resource_identity_id,
            conversation_id: target.conversation_id,
            transaction_id: target.transaction_id,
            request_digest: target.request_digest,
            projection_generation: target.projection_generation,
            session_generation: saved.session_generation,
            observation_event_id: input.observation_event_id,
          }),
        },
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return fail(503, "provider_evidence_unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail(
          response.status === 422 ? 422 : response.status === 409 ? 409 : 503,
          response.status === 422
            ? "provider_evidence_unsupported"
            : "provider_evidence_unavailable",
        );
      }
      value = responseSchema.parse(await boundedJson(response.body));
    } finally {
      clearTimeout(timer);
    }
    if (
      value.tenant_id !== input.tenant_id ||
      value.account_id !== target.account_id ||
      value.connection_id !== target.connection_id ||
      value.conversation_id !== target.conversation_id ||
      value.session_generation !== saved.session_generation ||
      value.transaction_id !== target.transaction_id ||
      value.request_digest !== target.request_digest ||
      value.projection_generation !== target.projection_generation ||
      value.evidence_id !== input.observation_event_id ||
      (value.source === "provider"
        ? value.status !== "delivered" ||
          value.reason !== "bridge_reported_dm_delivery"
        : value.status === "delivered" ||
          value.reason === "bridge_reported_dm_delivery")
    )
      return fail(409, "provider_evidence_conflict");
    if (!(await currentRoute(context.env, service, target)))
      return fail(409, "provider_evidence_conflict");
    const evidence = OutboundEvidenceInputSchema.parse({
      schema_version: 1,
      tenant_id: input.tenant_id,
      command_id: input.command_id,
      source: value.source,
      status: value.status,
      evidence_id: value.evidence_id,
      transaction_id: target.transaction_id,
      request_digest: target.request_digest,
      account_id: target.account_id,
      conversation_id: target.conversation_id,
      generation: target.projection_generation,
      observed_at: value.observed_at,
      remote_echo_id: value.remote_echo_id,
      reason: value.reason,
    });
    const result = await projection.reconcileOutbound({
      schema_version: 1,
      tenant_id: input.tenant_id,
      command_id: input.command_id,
      now: new Date().toISOString(),
      connection_available: true,
      evidence,
      provider_context: {
        dispatch_id: target.id,
        connection_id: target.connection_id,
        session_generation: saved.session_generation,
      },
    });
    // No body, recipient identity, or unredacted provider payload leaves this route.
    return context.json(
      {
        schema_version: 1,
        command_id: input.command_id,
        status: result.command.status,
        matrix_stage: result.dispatch.matrix_stage,
        bridge_stage: result.dispatch.bridge_stage,
        provider_stage: result.dispatch.provider_stage,
        provider_read: "unsupported",
      },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (error) {
    return error instanceof ProjectionError
      ? fail(409, "provider_evidence_conflict")
      : fail(503, "provider_evidence_unavailable");
  }
};

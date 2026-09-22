import {
  buildWebhookPayload,
  type StreamChoice,
  type StreamInput,
  type StreamPatch,
} from "./domain";
import { authorizeAccess } from "./auth";
import { STREAMS_LIVE_PATH, StreamsRoom } from "./room";
import { html, icon, manifest, serviceWorker } from "./ui";
import { handleMcpRequest } from "./mcp";

export { StreamsRoom };

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
const room = (env: Env) => env.STREAMS.getByName("don");

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new Error("JSON body required");
  return request.json<Record<string, unknown>>();
}

async function callTool(
  name: string,
  input: Record<string, unknown>,
  stub: DurableObjectStub<StreamsRoom>,
) {
  if (name === "upsert_stream") return stub.upsert(input as StreamInput);
  if (name === "reprioritize_stream")
    return stub.reprioritize(
      String(input.streamId),
      Number(input.priority),
      input.needsDon as boolean | undefined,
    );
  if (name === "archive_stream") return stub.archive(String(input.streamId));
  if (name === "set_stream_choices")
    return stub.setChoices(
      String(input.streamId),
      input.choices as StreamChoice[],
    );
  if (name === "patch_streams")
    return stub.patchStreams(input.patches as StreamPatch[]);
  if (name === "list_streams")
    return stub.listAll(input.includeArchived !== false);
  throw new Error(`Unknown tool: ${name}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/mcp") {
        return handleMcpRequest(request, env.MCP_AUTH_TOKEN, (name, input) =>
          callTool(name, input, room(env)),
        );
      }
      if (!(await authorizeAccess(request, env)))
        return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/manifest.webmanifest")
        return new Response(JSON.stringify(manifest), {
          headers: { "content-type": "application/manifest+json" },
        });
      if (url.pathname === "/icon.svg")
        return new Response(icon, {
          headers: {
            "content-type": "image/svg+xml",
            "cache-control": "public,max-age=86400",
          },
        });
      if (url.pathname === "/service-worker.js")
        return new Response(serviceWorker, {
          headers: {
            "content-type": "text/javascript",
            "service-worker-allowed": "/",
          },
        });
      if (url.pathname === "/" && request.method === "GET")
        return new Response(html, {
          headers: {
            "content-type": "text/html;charset=UTF-8",
            "cache-control": "no-store",
          },
        });
      if (url.pathname === STREAMS_LIVE_PATH && request.method === "GET")
        return room(env).fetch(request);
      if (url.pathname === "/api/streams" && request.method === "GET")
        return json(await room(env).list());
      if (
        url.pathname === "/api/decisions/unlock" &&
        request.method === "POST"
      ) {
        const input = (await parseBody(request)) as {
          streamId?: unknown;
          decisionId?: unknown;
        };
        if (typeof input.streamId !== "string" || !input.streamId.trim())
          return json({ error: "streamId is required" }, 400);
        if (typeof input.decisionId !== "string" || !input.decisionId.trim()) {
          return json({ error: "decisionId must be a nonempty string" }, 400);
        }
        const stream = await room(env).unlockDecision(
          input.streamId,
          input.decisionId,
        );
        return json({ ok: true, stream });
      }
      if (url.pathname === "/api/decisions" && request.method === "POST") {
        const input = (await parseBody(request)) as {
          decisionId: string;
          streamId: string;
          choiceId: string;
          value: string;
          freeText?: string;
        };
        if (
          !input.decisionId ||
          !input.streamId ||
          !input.choiceId ||
          !input.value
        )
          return json({ error: "Missing decision fields" }, 400);
        const now = new Date();
        const start = await room(env).beginDecision({
          ...input,
          freeText: input.freeText ?? "",
          createdAt: now.toISOString(),
        });
        if (start.action === "submitted")
          return json({ ok: true, duplicate: true });
        if (start.action === "pending")
          return json({ ok: false, pending: true }, 202);
        const payload = buildWebhookPayload({
          streamId: start.streamId,
          choiceId: start.choiceId,
          value: start.value,
          freeText: start.freeText,
          decisionId: start.decisionId,
          kind: start.kind,
          correctionOf: start.correctionOf,
          createdAt: start.createdAt,
        });
        // Phase 2: prefer per-stream head webhook; fall back to CoS env webhook.
        let webhookUrl = env.GROK_WEBHOOK_URL;
        let webhookAuthorization = `Bearer ${env.GROK_WEBHOOK_AUTHORIZATION}`;
        try {
          const streamDoc = await room(env).get(start.streamId);
          const overrideUrl = streamDoc?.choiceWebhookUrl?.trim();
          if (overrideUrl) {
            webhookUrl = overrideUrl;
            const overrideAuth = streamDoc?.choiceWebhookAuthorization?.trim();
            if (overrideAuth) webhookAuthorization = overrideAuth;
          }
        } catch {
          // Tests / stubs may not implement get — env webhook still works.
        }
        try {
          const webhook = await fetch(webhookUrl, {
            method: "POST",
            headers: {
              authorization: webhookAuthorization,
              "content-type": "application/json",
              "idempotency-key": start.decisionId,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (!webhook.ok) throw new Error(`HTTP ${webhook.status}`);
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message.slice(0, 120)
              : "network failure";
          await room(env).finishDecision(
            start.decisionId,
            start.attemptedAt,
            "failed",
            reason,
          );
          return json(
            {
              error: "Grok webhook did not accept the decision",
              decisionId: start.decisionId,
              status: "failed",
              retryable: true,
            },
            502,
          );
        }
        await room(env).finishDecision(
          start.decisionId,
          start.attemptedAt,
          "submitted",
        );
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Request failed" },
        400,
      );
    }
  },
} satisfies ExportedHandler<Env>;

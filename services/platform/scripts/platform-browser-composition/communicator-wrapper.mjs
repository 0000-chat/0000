import worker, {
  LinkSessionDO,
  TenantProjectionDO,
} from "../../../communicator/apps/control-plane/worker/index.ts";

const harnessError = (error, status) =>
  Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );

const readHarnessBody = async (request) => {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch {
    return null;
  }
};

const hasHarnessAccess = (request, env) =>
  typeof env.COMPOSITION_HARNESS_TOKEN === "string" &&
  env.COMPOSITION_HARNESS_TOKEN.length > 0 &&
  request.headers.get("x-composition-harness-token") ===
    env.COMPOSITION_HARNESS_TOKEN;

const runProjectionOperation = async (request, env, operation) => {
  if (!hasHarnessAccess(request, env))
    return harnessError("harness_denied", 403);
  const body = await readHarnessBody(request);
  if (
    body === null ||
    typeof body.tenant_id !== "string" ||
    !body.input ||
    typeof body.input !== "object" ||
    Array.isArray(body.input)
  ) {
    return harnessError("harness_invalid_request", 400);
  }
  try {
    const projection = env.TENANT_PROJECTION.getByName(body.tenant_id);
    await projection[operation](body.input);
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return harnessError("harness_operation_failed", 500);
  }
};

const fetch = async (request, env, executionContext) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/__composition/projection/initialize") {
    return runProjectionOperation(request, env, "initialize");
  }
  if (pathname === "/__composition/projection/apply") {
    return runProjectionOperation(request, env, "applyBatch");
  }
  return worker.fetch(request, env, executionContext);
};

export default {
  ...worker,
  fetch,
};

export { LinkSessionDO, TenantProjectionDO };

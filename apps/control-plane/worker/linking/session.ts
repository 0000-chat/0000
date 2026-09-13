import type {
  LinkSessionAction,
  LinkSessionErrorCode,
  LinkSessionStatus,
  Provider,
} from "@communicator/contracts";

const STATE_KEY = "link-session";
const PRODUCT_TTL_MS = 10 * 60_000;

export type LinkSessionOwner = {
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  target_identity_id: string;
  provider: Provider;
};

export type LinkSessionState = LinkSessionOwner & {
  id: string;
  generation: number;
  status: LinkSessionStatus;
  action: LinkSessionAction;
  expires_at: string;
  action_expires_at: string | null;
  gateway_ref: string | null;
  connection_id: string | null;
  account_id: string | null;
  provider_label: string | null;
  error_code: LinkSessionErrorCode | null;
  request_key_digest: string;
  created_at: string;
  updated_at: string;
};

type SessionCommand =
  | { command: "create"; state: LinkSessionState }
  | { command: "read" }
  | { command: "begin"; owner: LinkSessionOwner; generation: number }
  | {
      command: "set_gateway";
      owner: LinkSessionOwner;
      generation: number;
      gateway_ref: string;
      action_expires_at: string | null;
    }
  | {
      command: "set_provider_state";
      owner: LinkSessionOwner;
      generation: number;
      status: Extract<LinkSessionStatus, "awaiting_user" | "authenticating" | "failed" | "expired">;
      action: LinkSessionAction;
      action_expires_at: string | null;
      error_code: LinkSessionErrorCode | null;
    }
  | { command: "refresh"; owner: LinkSessionOwner; generation: number }
  | { command: "invalidate"; owner: LinkSessionOwner; generation: number; status: "cancelled" | "expired" }
  | {
      command: "finish";
      owner: LinkSessionOwner;
      generation: number;
      status: Extract<LinkSessionStatus, "connected" | "relink_required" | "reconciliation_required">;
      error_code: LinkSessionErrorCode | null;
      connection_id: string | null;
      account_id: string | null;
      provider_label: string | null;
    };

type CommandResult = {
  state: LinkSessionState;
  previous_gateway_ref?: string | null;
  created: boolean;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const now = (): string => new Date().toISOString();

const safeState = (state: LinkSessionState): LinkSessionState => ({
  ...state,
  // This function is the only object persisted by the DO. QR data and
  // provider process/transaction IDs are deliberately absent from it.
});

const ownerMatches = (state: LinkSessionState, owner: LinkSessionOwner) =>
  state.tenant_id === owner.tenant_id &&
  state.actor_principal_id === owner.actor_principal_id &&
  state.membership_id === owner.membership_id &&
  state.target_identity_id === owner.target_identity_id &&
  state.provider === owner.provider;

const terminal = (status: LinkSessionStatus): boolean =>
  status === "connected" ||
  status === "expired" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "relink_required" ||
  status === "reconciliation_required";

const ensureCurrent = (
  state: LinkSessionState,
  owner: LinkSessionOwner,
  generation: number,
): void => {
  if (!ownerMatches(state, owner) || state.generation !== generation) {
    throw new SessionCommandError("stale_session", 409);
  }
};

class SessionCommandError extends Error {
  constructor(
    readonly code: "stale_session" | "not_found" | "terminal_session" | "invalid_session",
    readonly status: 404 | 409 | 422,
  ) {
    super(code);
  }
}

const expireIfNeeded = async (
  ctx: DurableObjectState,
  state: LinkSessionState,
): Promise<LinkSessionState> => {
  if (
    !terminal(state.status) &&
    Date.parse(state.expires_at) <= Date.now()
  ) {
    const expired: LinkSessionState = {
      ...state,
      generation: state.generation + 1,
      status: "expired",
      action: "none",
      action_expires_at: null,
      gateway_ref: state.gateway_ref,
      error_code: "expired",
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(expired));
    return expired;
  }
  return state;
};

async function readState(ctx: DurableObjectState): Promise<LinkSessionState> {
  const state = await ctx.storage.get<LinkSessionState>(STATE_KEY);
  if (!state) throw new SessionCommandError("not_found", 404);
  return expireIfNeeded(ctx, state);
}

async function cancelGatewayReference(
  env: Cloudflare.Env,
  state: LinkSessionState,
): Promise<void> {
  const runtimeEnv = env as Cloudflare.Env & {
    CONNECTION_GATEWAY_URL?: string;
    CONNECTION_GATEWAY_TOKEN?: string;
  };
  if (!state.gateway_ref || !runtimeEnv.CONNECTION_GATEWAY_URL) return;
  try {
    await fetch(`${runtimeEnv.CONNECTION_GATEWAY_URL}/v1/link-sessions/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeEnv.CONNECTION_GATEWAY_TOKEN ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        session_id: state.id,
        tenant_id: state.tenant_id,
        actor_principal_id: state.actor_principal_id,
        membership_id: state.membership_id,
        target_identity_id: state.target_identity_id,
        provider: state.provider,
        generation: state.generation,
        gateway_ref: state.gateway_ref,
      }),
    });
  } catch {
    // The local generation is already terminal. The next cleanup attempt can
    // use the gateway's opaque reference; no provider detail is retained here.
  }
}

async function execute(
  ctx: DurableObjectState,
  env: Cloudflare.Env,
  input: SessionCommand,
): Promise<CommandResult> {
  if (input.command === "create") {
    const existing = await ctx.storage.get<LinkSessionState>(STATE_KEY);
    if (existing) {
      if (existing.request_key_digest !== input.state.request_key_digest) {
        throw new SessionCommandError("invalid_session", 422);
      }
      return { state: await expireIfNeeded(ctx, existing), created: false };
    }
    const state = safeState(input.state);
    await ctx.storage.put(STATE_KEY, state);
    await ctx.storage.setAlarm(Date.parse(state.expires_at));
    return { state, created: true };
  }

  let state = await readState(ctx);
  if (input.command === "read") return { state, created: false };

  if ("owner" in input) ensureCurrent(state, input.owner, input.generation);

  if (input.command === "begin") {
    if (terminal(state.status))
      throw new SessionCommandError("terminal_session", 409);
    return { state, created: false };
  }

  if (input.command === "set_gateway") {
    if (terminal(state.status))
      throw new SessionCommandError("terminal_session", 409);
    state = {
      ...state,
      status: "awaiting_user",
      action: "scan_qr",
      action_expires_at: input.action_expires_at,
      gateway_ref: input.gateway_ref,
      error_code: null,
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(state));
    return { state, created: false };
  }

  if (input.command === "set_provider_state") {
    if (terminal(state.status))
      throw new SessionCommandError("terminal_session", 409);
    state = {
      ...state,
      status: input.status,
      action: input.action,
      action_expires_at: input.action_expires_at,
      error_code: input.error_code,
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(state));
    return { state, created: false };
  }

  if (input.command === "refresh") {
    if (terminal(state.status))
      throw new SessionCommandError("terminal_session", 409);
    const previous = state.gateway_ref;
    state = {
      ...state,
      generation: state.generation + 1,
      status: "created",
      action: "none",
      action_expires_at: null,
      gateway_ref: null,
      error_code: null,
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(state));
    return { state, previous_gateway_ref: previous, created: false };
  }

  if (input.command === "invalidate") {
    if (terminal(state.status)) return { state, created: false };
    const previous = state.gateway_ref;
    state = {
      ...state,
      generation: state.generation + 1,
      status: input.status,
      action: "none",
      action_expires_at: null,
      error_code: input.status === "expired" ? "expired" : "cancelled",
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(state));
    return { state, previous_gateway_ref: previous, created: false };
  }

  if (input.command === "finish") {
    if (terminal(state.status)) return { state, created: false };
    state = {
      ...state,
      status: input.status,
      action: "none",
      action_expires_at: null,
      gateway_ref: null,
      error_code: input.error_code,
      connection_id: input.connection_id,
      account_id: input.account_id,
      provider_label: input.provider_label,
      updated_at: now(),
    };
    await ctx.storage.put(STATE_KEY, safeState(state));
    return { state, created: false };
  }

  throw new SessionCommandError("invalid_session", 422);
}

export class LinkSessionDO {
  constructor(
    private readonly stateCtx: DurableObjectState,
    private readonly runtimeEnv: Cloudflare.Env,
  ) {
  }

  async fetch(request: Request): Promise<Response> {
    let input: SessionCommand;
    try {
      input = (await request.json()) as SessionCommand;
    } catch {
      return json({ error: "invalid_session" }, 400);
    }
    try {
      return json(await execute(this.stateCtx, this.runtimeEnv, input));
    } catch (error) {
      if (error instanceof SessionCommandError) {
        return json({ error: error.code }, error.status);
      }
      return json({ error: "session_unavailable" }, 503);
    }
  }

  async alarm(): Promise<void> {
    try {
      const state = await readState(this.stateCtx);
      if (terminal(state.status)) return;
      const previous = state.gateway_ref;
      const expired: LinkSessionState = {
        ...state,
        generation: state.generation + 1,
        status: "expired",
        action: "none",
        action_expires_at: null,
        error_code: "expired",
        updated_at: now(),
      };
      await this.stateCtx.storage.put(STATE_KEY, safeState(expired));
      await cancelGatewayReference(this.runtimeEnv, { ...expired, gateway_ref: previous });
    } catch {
      // An absent/invalid session has no cleanup work.
    }
  }
}

export const LINK_SESSION_TTL_MS = PRODUCT_TTL_MS;

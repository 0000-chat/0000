import {
  ProviderSchema,
  type Provider,
} from "@communicator/contracts";

export type GatewayOwner = {
  session_id: string;
  tenant_id: string;
  actor_principal_id: string;
  membership_id: string;
  target_identity_id: string;
  provider: Provider;
  generation: number;
};

export type GatewayRoute = {
  gateway_route_id: string;
  bridge_instance_id: string;
  matrix_user_id: string;
  matrix_room_namespace: string;
};

export type GatewayStartResult = {
  gateway_ref: string;
  action: "scan_qr";
  qr: string;
  action_expires_at: string | null;
};

export type GatewayPollResult =
  | {
      status: "awaiting_user";
      action: "scan_qr" | "wait";
      qr: string | null;
      action_expires_at: string | null;
    }
  | {
      status: "connected";
      provider_identity: {
        user_login_id: string;
        display_label: string;
        route: GatewayRoute;
      };
    }
  | {
      status: "expired";
      error_code: "expired";
    }
  | {
      status: "failed";
      error_code:
        | "provider_unavailable"
        | "provider_error"
        | "provisioning_disabled";
    };

export interface ConnectionGateway {
  start(owner: GatewayOwner): Promise<GatewayStartResult>;
  poll(owner: GatewayOwner & { gateway_ref: string }): Promise<GatewayPollResult>;
  cancel(owner: GatewayOwner & { gateway_ref: string }): Promise<void>;
}

export class ConnectionGatewayError extends Error {
  constructor(
    readonly code:
      | "provider_unavailable"
      | "provider_error"
      | "provisioning_disabled",
    readonly status?: number,
  ) {
    super(code);
    this.name = "ConnectionGatewayError";
  }
}

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const parseStart = (value: unknown): GatewayStartResult => {
  if (
    typeof value !== "object" ||
    value === null ||
    !isString((value as { gateway_ref?: unknown }).gateway_ref) ||
    (value as { action?: unknown }).action !== "scan_qr" ||
    !isString((value as { qr?: unknown }).qr) ||
    ((value as { action_expires_at?: unknown }).action_expires_at !== null &&
      !isString((value as { action_expires_at?: unknown }).action_expires_at))
  ) {
    throw new ConnectionGatewayError("provider_error");
  }
  return {
    gateway_ref: (value as { gateway_ref: string }).gateway_ref,
    action: "scan_qr",
    qr: (value as { qr: string }).qr,
    action_expires_at: (value as { action_expires_at: string | null })
      .action_expires_at,
  };
};

const parseRoute = (value: unknown): GatewayRoute | null => {
  if (typeof value !== "object" || value === null) return null;
  const route = value as Partial<GatewayRoute>;
  if (
    !isString(route.gateway_route_id) ||
    !isString(route.bridge_instance_id) ||
    !isString(route.matrix_user_id) ||
    !isString(route.matrix_room_namespace)
  )
    return null;
  return {
    gateway_route_id: route.gateway_route_id,
    bridge_instance_id: route.bridge_instance_id,
    matrix_user_id: route.matrix_user_id,
    matrix_room_namespace: route.matrix_room_namespace,
  };
};

const parsePoll = (value: unknown): GatewayPollResult => {
  if (typeof value !== "object" || value === null)
    throw new ConnectionGatewayError("provider_error");
  const result = value as Record<string, unknown>;
  if (result.status === "awaiting_user") {
    if (result.action !== "scan_qr" && result.action !== "wait")
      throw new ConnectionGatewayError("provider_error");
    if (result.qr !== null && !isString(result.qr))
      throw new ConnectionGatewayError("provider_error");
    if (
      result.action_expires_at !== null &&
      !isString(result.action_expires_at)
    )
      throw new ConnectionGatewayError("provider_error");
    return {
      status: "awaiting_user",
      action: result.action,
      qr: result.qr,
      action_expires_at: result.action_expires_at,
    };
  }
  if (result.status === "connected") {
    const identity = result.provider_identity;
    if (typeof identity !== "object" || identity === null)
      throw new ConnectionGatewayError("provider_error");
    const typed = identity as Record<string, unknown>;
    const route = parseRoute(typed.route);
    if (
      !isString(typed.user_login_id) ||
      !isString(typed.display_label) ||
      !route
    )
      throw new ConnectionGatewayError("provider_error");
    return {
      status: "connected",
      provider_identity: {
        user_login_id: typed.user_login_id,
        display_label: typed.display_label,
        route,
      },
    };
  }
  if (result.status === "expired") return { status: "expired", error_code: "expired" };
  if (result.status === "failed") {
    const code = result.error_code;
    if (
      code !== "provider_unavailable" &&
      code !== "provider_error" &&
      code !== "provisioning_disabled"
    )
      throw new ConnectionGatewayError("provider_error");
    return { status: "failed", error_code: code };
  }
  throw new ConnectionGatewayError("provider_error");
};

const validateOwner = (owner: GatewayOwner): void => {
  if (
    !isString(owner.session_id) ||
    !isString(owner.tenant_id) ||
    !isString(owner.actor_principal_id) ||
    !isString(owner.membership_id) ||
    !isString(owner.target_identity_id) ||
    !ProviderSchema.safeParse(owner.provider).success ||
    !Number.isSafeInteger(owner.generation) ||
    owner.generation < 1
  )
    throw new ConnectionGatewayError("provider_error");
};

export class HttpConnectionGateway implements ConnectionGateway {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly sharedSecret: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    if (!baseUrl || !sharedSecret) throw new ConnectionGatewayError("provider_unavailable");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.sharedSecret}`,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ConnectionGatewayError("provider_unavailable");
    }
    if (response.status === 401 || response.status === 403)
      throw new ConnectionGatewayError("provisioning_disabled", response.status);
    if (response.status >= 500)
      throw new ConnectionGatewayError("provider_unavailable", response.status);
    if (!response.ok) throw new ConnectionGatewayError("provider_error", response.status);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ConnectionGatewayError("provider_error", response.status);
    }
    return parse(value);
  }

  start(owner: GatewayOwner): Promise<GatewayStartResult> {
    validateOwner(owner);
    return this.request("/v1/link-sessions/start", owner, parseStart);
  }

  poll(owner: GatewayOwner & { gateway_ref: string }): Promise<GatewayPollResult> {
    validateOwner(owner);
    if (!isString(owner.gateway_ref))
      return Promise.reject(new ConnectionGatewayError("provider_error"));
    return this.request("/v1/link-sessions/poll", owner, parsePoll);
  }

  async cancel(owner: GatewayOwner & { gateway_ref: string }): Promise<void> {
    validateOwner(owner);
    if (!isString(owner.gateway_ref)) return;
    await this.request("/v1/link-sessions/cancel", owner, () => undefined);
  }
}

export const gatewayFromEnv = (env: Cloudflare.Env): ConnectionGateway => {
  const runtimeEnv = env as Cloudflare.Env & {
    CONNECTION_GATEWAY_URL?: string;
    CONNECTION_GATEWAY_TOKEN?: string;
  };
  return new HttpConnectionGateway(
    runtimeEnv.CONNECTION_GATEWAY_URL ?? "",
    runtimeEnv.CONNECTION_GATEWAY_TOKEN ?? "",
  );
};

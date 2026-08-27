import { z } from "zod";
import {
  CommunicatorIdSchema,
  CommandSchema,
  ConnectionSchema,
  ConversationSummarySchema,
  IdentitySchema,
  MessageSchema,
  type Command,
  type Connection,
  type ConversationSummary,
  type Identity,
  type Message,
} from "@communicator/contracts";

const MeResponseSchema = z.object({
  tenant_id: CommunicatorIdSchema,
  principal_id: CommunicatorIdSchema,
  display_name: z.string().min(1),
  authorized_identity_ids: z.array(CommunicatorIdSchema),
}).strict();

const ResetResponseSchema = z.object({
  status: z.literal("reset"),
  scenario: z.enum(["ready", "attention_required"]),
  fixture_reset_at: z.string().datetime({ offset: true }),
}).strict();

const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("communicator-control-plane"),
  data_mode: z.enum(["unconfigured", "simulated", "live"]),
}).strict();

export type MeResponse = z.infer<typeof MeResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ResetResponse = z.infer<typeof ResetResponseSchema>;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  constructor(
    private readonly fetcher?: typeof fetch,
    private readonly baseUrl = "",
  ) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const url = this.baseUrl
      ? `${this.baseUrl}${path}`
      : new URL(path, globalThis.location?.origin ?? "http://example.test").toString();
    const response = await (this.fetcher ?? globalThis.fetch)(url, init);
    if (!response.ok) {
      throw new ApiError(response.status, `Communicator API request failed with ${response.status}`);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(502, "Communicator API returned an invalid response");
    }
    return parsed.data;
  }

  getMe() {
    return this.request("/api/v1/me", MeResponseSchema);
  }

  getIdentities(): Promise<Identity[]> {
    return this.request("/api/v1/identities", IdentitySchema.array());
  }

  getConnections(identityId: string): Promise<Connection[]> {
    return this.request(
      `/api/v1/connections?identity_id=${encodeURIComponent(identityId)}`,
      ConnectionSchema.array(),
    );
  }

  getConversations(identityId: string): Promise<ConversationSummary[]> {
    return this.request(
      `/api/v1/conversations?identity_id=${encodeURIComponent(identityId)}`,
      ConversationSummarySchema.array(),
    );
  }

  getMessages(conversationId: string, identityId: string): Promise<Message[]> {
    return this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages?identity_id=${encodeURIComponent(identityId)}`,
      MessageSchema.array(),
    );
  }

  getCommands(identityId: string): Promise<Command[]> {
    return this.request(
      `/api/v1/commands?identity_id=${encodeURIComponent(identityId)}`,
      CommandSchema.array(),
    );
  }

  sendMessage({
    conversationId,
    identityId,
    body,
    deliveryMode,
    idempotencyKey,
  }: {
    conversationId: string;
    identityId: string;
    body: string;
    deliveryMode: "direct" | "paced";
    idempotencyKey: string;
  }): Promise<Command> {
    return this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      CommandSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          identity_id: identityId,
          body,
          delivery_mode: deliveryMode,
        }),
      },
    );
  }

  resetSimulation(scenario: "ready" | "attention_required" = "ready"): Promise<ResetResponse> {
    return this.request("/api/v1/testing/reset", ResetResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario }),
    });
  }

  getHealth(): Promise<HealthResponse> {
    return this.request("/api/v1/health", HealthResponseSchema);
  }
}

export const apiClient = new ApiClient();

import { describe, expect, it, vi } from "vitest";
import {
  HttpWhatsAppReceiptProvider,
  type ReceiptDispatchPayload,
} from "../receipts/provider";

const environment = {
  CONNECTION_GATEWAY_URL: "https://gateway.example.test/",
  CONNECTION_GATEWAY_TOKEN: "receipt-gateway-secret-123",
} as unknown as Cloudflare.Env;

const payload: ReceiptDispatchPayload = {
  route: {
    tenant_id: "tenant_pilot",
    identity_id: "identity_human",
    account_id: "account_human_whatsapp",
    connection_id: "connection_human_whatsapp",
    provider: "whatsapp",
    session_generation: "2026-09-14T00:00:00.000Z",
    gateway_route_id: "gateway_route_human",
    bridge_instance_id: "bridge-whatsapp",
    matrix_user_id: "@human:example.test",
    matrix_room_namespace: "communicator.0000.gold",
    provider_login_id: "login-primary",
  },
  membership_id: "membership_human",
  actor_identity_id: "identity_human",
  reservation_id: "receipt_reservation_1",
  capability: {
    kind: "account_grant",
    grant_id: "grant_receipt_send",
    authorization_epoch: 2,
  },
  request_hash: "a".repeat(64),
  operation_id: "receipt_operation_1",
  operation_created_at: "2026-09-14T00:00:00.000Z",
  conversation_id: "conversation_receipt",
  message_id: "message_receipt",
  matrix_room_id: "!receipt:example.test",
  matrix_event_id: "$receipt:example.test",
  receipt_position: "$receipt:example.test",
};

describe("WhatsApp receipt provider", () => {
  it("sends the account-bound route and preserves provider evidence", async () => {
    const fetcher: typeof fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        route: ReceiptDispatchPayload["route"];
        matrix_event_id: string;
        membership_id: string;
        actor_identity_id: string;
        reservation_id: string;
        capability: ReceiptDispatchPayload["capability"];
        request_hash: string;
      };
      expect(body.route.account_id).toBe(payload.route.account_id);
      expect(body.route.provider_login_id).toBe("login-primary");
      expect(body.matrix_event_id).toBe(payload.matrix_event_id);
      expect(body.membership_id).toBe(payload.membership_id);
      expect(body.actor_identity_id).toBe(payload.actor_identity_id);
      expect(body.reservation_id).toBe(payload.reservation_id);
      expect(body.capability).toEqual(payload.capability);
      expect(body.request_hash).toBe(payload.request_hash);
      return new Response(
        JSON.stringify({
          status: "accepted",
          operation_id: payload.operation_id,
          matrix_stage: "accepted",
          bridge_stage: "unknown",
          provider_stage: "unknown",
          evidence: [
            {
              source: "matrix",
              status: "accepted",
              evidence_id: "matrix:$receipt:example.test",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider = new HttpWhatsAppReceiptProvider(environment, fetcher);

    await expect(provider.dispatch(payload)).resolves.toMatchObject({
      status: "accepted",
      matrix_stage: "accepted",
      provider_stage: "unknown",
      evidence: [
        {
          source: "matrix",
          status: "accepted",
          evidence_id: "matrix:$receipt:example.test",
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://gateway.example.test/v1/receipts/read",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer receipt-gateway-secret-123",
          "idempotency-key": "receipt-receipt_operation_1",
        }),
      }),
    );
  });

  it("classifies gateway timeouts without manufacturing receipt evidence", async () => {
    const fetcher: typeof fetch = vi.fn(
      async () => new Response("", { status: 504 }),
    );
    const provider = new HttpWhatsAppReceiptProvider(environment, fetcher);

    await expect(provider.dispatch(payload)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rejects evidence correlated to a different receipt operation", async () => {
    const fetcher: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "accepted",
            operation_id: "receipt_operation_other",
            matrix_stage: "accepted",
            bridge_stage: "unknown",
            provider_stage: "unknown",
            evidence: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const provider = new HttpWhatsAppReceiptProvider(environment, fetcher);

    await expect(provider.dispatch(payload)).rejects.toMatchObject({
      code: "protocol",
    });
  });
});

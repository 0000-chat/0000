import fixture from "../../../../../services/matrix-gateway/testdata/relink-room-rebind-v1.json";
import { describe, expect, it, vi } from "vitest";
import {
  HttpConnectionGateway,
  type GatewayRoomRebind,
} from "../../linking/gateway-client";

const contractFixture = fixture as unknown as {
  schema_version: 1;
  tenant_id: string;
  account_id: string;
  connection_id: string;
  identity_id: string;
  provider: "whatsapp";
  old_session_generation: string;
  new_session_generation: string;
  route: {
    gateway_route_id: string;
    bridge_instance_id: string;
    matrix_user_id: string;
    matrix_room_namespace: string;
    provider_login_id: string;
  };
};

describe("Matrix gateway relink boundary", () => {
  it("serializes the Worker rebind adapter envelope accepted by Rust", async () => {
    const fetcher: typeof fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://gateway.example/v1/connections/rebind-rooms");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual(contractFixture);
      expect(Object.keys(body).sort()).toEqual(
        Object.keys(contractFixture).sort(),
      );
      expect(body).not.toHaveProperty("session_id");
      expect(body).not.toHaveProperty("actor_principal_id");
      expect(body).not.toHaveProperty("membership_id");
      expect(body).not.toHaveProperty("target_identity_id");
      expect(body).not.toHaveProperty("generation");
      expect(body).not.toHaveProperty("provider_login_id");
      expect(body.route).toMatchObject({ provider_login_id: "login-relink" });
      return new Response(JSON.stringify({ status: "rebound", rebound: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const gateway = new HttpConnectionGateway(
      "https://gateway.example/",
      "gateway-secret-0123456789",
      fetcher,
    );

    // Keep legacy owner-shaped fields here to ensure the adapter's wire
    // serializer cannot accidentally forward them to Rust's deny-unknown-
    // fields request deserializer. The shared vector is consumed by the Rust
    // endpoint regression in provisioning.rs.
    const input = {
      session_id: "session-owner-only",
      tenant_id: contractFixture.tenant_id,
      actor_principal_id: "actor-owner-only",
      membership_id: "membership-owner-only",
      target_identity_id: contractFixture.identity_id,
      generation: 4,
      provider: contractFixture.provider,
      connection_id: contractFixture.connection_id,
      account_id: contractFixture.account_id,
      provider_login_id: contractFixture.route.provider_login_id,
      old_session_generation: contractFixture.old_session_generation,
      new_session_generation: contractFixture.new_session_generation,
      route: {
        gateway_route_id: contractFixture.route.gateway_route_id,
        bridge_instance_id: contractFixture.route.bridge_instance_id,
        matrix_user_id: contractFixture.route.matrix_user_id,
        matrix_room_namespace: contractFixture.route.matrix_room_namespace,
      },
    } as unknown as GatewayRoomRebind;

    await expect(gateway.rebindRooms(input)).resolves.toEqual({
      status: "rebound",
      rebound: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

import { MAX_ATTACHMENT_BYTES, type Provider } from "@communicator/contracts";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../archive/codec";
import {
  HttpAttachmentProvider,
  type AttachmentProviderInput,
} from "../../attachments/provider";

const bytes = new TextEncoder().encode("provider fixture bytes");
const provider: Provider = "whatsapp";

const inputFor = async (
  overrides: Partial<AttachmentProviderInput> = {},
): Promise<AttachmentProviderInput> => ({
  tenant_id: "tenant_pilot",
  account_id: "account_human",
  connection_id: "connection_human_whatsapp",
  identity_id: "identity_human",
  conversation_id: "conversation_attachment",
  message_id: "message_attachment",
  attachment_id: "attachment_fixture_image",
  revision: "event_attachment_observed",
  provider,
  media_key: `media/tenant_pilot/${await sha256Hex(bytes)}`,
  expected_size_bytes: bytes.byteLength,
  expected_sha256: await sha256Hex(bytes),
  expected_mime_type: "image/png",
  ...overrides,
});

const encoded = (): string => btoa(String.fromCharCode(...bytes));

describe("private attachment provider boundary", () => {
  it("sends only scoped IDs and returns verified bounded bytes", async () => {
    const input = await inputFor();
    const fetcher: typeof fetch = vi.fn(async (url, init) => {
      expect(url).toBe("https://gateway.example/v1/attachments/read");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer gateway-secret-0123456789",
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual(input);
      expect(JSON.stringify(body)).not.toContain("gateway-secret-0123456789");
      return new Response(
        JSON.stringify({
          status: "available",
          bytes_base64: encoded(),
          mime_type: "image/png",
          size_bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const attachmentProvider = new HttpAttachmentProvider(
      "https://gateway.example/",
      "gateway-secret-0123456789",
      fetcher,
    );

    await expect(attachmentProvider.read(input)).resolves.toEqual({
      status: "available",
      bytes,
      mime_type: "image/png",
      sha256: await sha256Hex(bytes),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed for arbitrary media keys and oversized expected data", async () => {
    const fetcher: typeof fetch = vi.fn();
    const attachmentProvider = new HttpAttachmentProvider(
      "https://gateway.example",
      "gateway-secret-0123456789",
      fetcher,
    );

    await expect(
      attachmentProvider.read(
        await inputFor({ media_key: "https://upstream.example/private-media" }),
      ),
    ).rejects.toMatchObject({
      code: "provider_error",
    });
    await expect(
      attachmentProvider.read(
        await inputFor({ expected_size_bytes: MAX_ATTACHMENT_BYTES + 1 }),
      ),
    ).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [408, "provider_timeout"],
    [504, "provider_timeout"],
    [401, "provider_rejected"],
    [403, "provider_rejected"],
    [404, "missing"],
    [410, "missing"],
  ] as const)("maps gateway status %s to %s", async (status, reason) => {
    const fetcher: typeof fetch = vi.fn(
      async () => new Response(null, { status }),
    );
    const attachmentProvider = new HttpAttachmentProvider(
      "https://gateway.example",
      "gateway-secret-0123456789",
      fetcher,
    );
    await expect(attachmentProvider.read(await inputFor())).resolves.toEqual({
      status: "unavailable",
      reason,
    });
  });

  it("rejects malformed or hash-mismatched gateway payloads", async () => {
    const input = await inputFor();
    const fetcher: typeof fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "available",
            bytes_base64: encoded(),
            mime_type: "image/png",
            size_bytes: bytes.byteLength + 1,
            sha256: await sha256Hex(bytes),
          }),
          { status: 200 },
        ),
    );
    const attachmentProvider = new HttpAttachmentProvider(
      "https://gateway.example",
      "gateway-secret-0123456789",
      fetcher,
    );
    await expect(attachmentProvider.read(input)).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("turns a gateway timeout into an unavailable result", async () => {
    const fetcher: typeof fetch = vi.fn(async () => {
      throw new Error("controlled timeout");
    });
    const attachmentProvider = new HttpAttachmentProvider(
      "https://gateway.example",
      "gateway-secret-0123456789",
      fetcher,
    );
    await expect(attachmentProvider.read(await inputFor())).resolves.toEqual({
      status: "unavailable",
      reason: "provider_unavailable",
    });
  });
});

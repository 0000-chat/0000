import { describe, expect, test } from "bun:test"

import {
  buildApprovalInteractionRecord,
  buildElicitationInteractionRecord,
  redactCorrelationMetadata,
  resolveElicitationResponseInteraction,
  toElicitationPendingInteractionId,
  validateZeroChatExtensionNamespace,
} from "./interaction-extensions"

describe("0000 chat extension helpers", () => {
  test("resolves elicitation responses to the matching pending interaction", () => {
    const interaction = {
      interactionId: toElicitationPendingInteractionId("interaction-1")!,
      requestId: "request-1",
      createdAtMs: 100,
      expiresAtMs: 500,
    }

    expect(
      resolveElicitationResponseInteraction({
        interactionId: "interaction-1",
        pendingInteractions: [interaction],
        nowMs: 200,
      }),
    ).toEqual({ ok: true, interaction })
  })

  test("rejects missing, malformed, stale, and expired elicitation responses", () => {
    const pending = {
      interactionId: toElicitationPendingInteractionId("interaction-1")!,
      requestId: "request-1",
      createdAtMs: 100,
      expiresAtMs: 200,
    }

    expect(
      resolveElicitationResponseInteraction({
        interactionId: undefined,
        pendingInteractions: [pending],
        nowMs: 150,
      }),
    ).toEqual({ ok: false, reason: "missing_interaction_id" })
    expect(
      resolveElicitationResponseInteraction({
        interactionId: "   ",
        pendingInteractions: [pending],
        nowMs: 150,
      }),
    ).toEqual({ ok: false, reason: "missing_interaction_id" })
    expect(
      resolveElicitationResponseInteraction({
        interactionId: "interaction 1",
        pendingInteractions: [pending],
        nowMs: 150,
      }),
    ).toEqual({ ok: false, reason: "missing_interaction_id" })
    expect(
      resolveElicitationResponseInteraction({
        interactionId: "interaction-2",
        pendingInteractions: [pending],
        nowMs: 150,
      }),
    ).toEqual({ ok: false, reason: "stale_interaction" })
    expect(
      resolveElicitationResponseInteraction({
        interactionId: "interaction-1",
        pendingInteractions: [pending],
        nowMs: 200,
      }),
    ).toEqual({ ok: false, reason: "expired_interaction" })
  })

  test("rejects ambiguous elicitation responses when duplicate pending interactions exist", () => {
    const interactionId = toElicitationPendingInteractionId("interaction-1")!
    const pendingInteractions = [
      {
        interactionId,
        requestId: "request-1",
        createdAtMs: 100,
      },
      {
        interactionId,
        requestId: "request-2",
        createdAtMs: 110,
      },
    ]

    expect(
      resolveElicitationResponseInteraction({
        interactionId,
        pendingInteractions,
        nowMs: 150,
      }),
    ).toEqual({ ok: false, reason: "ambiguous_interaction" })
  })

  test("preserves approval request, response, resolved, and stale identity", () => {
    const workItem = {
      agentSessionId: "agent-session-1",
      queueItemId: "queue-1",
      sessionKey: "session-1",
      threadId: "thread-1",
    }

    expect(
      buildApprovalInteractionRecord({
        approvalId: "approval-1",
        status: "requested",
        workItem,
      }),
    ).toEqual({
      category: "approval",
      approvalId: "approval-1",
      status: "requested",
      workItem,
    })

    expect(
      buildApprovalInteractionRecord({
        approvalId: "approval-1",
        responseId: "response-1",
        status: "responded",
        workItem,
      }),
    ).toEqual({
      category: "approval",
      approvalId: "approval-1",
      responseId: "response-1",
      status: "responded",
      workItem,
    })

    expect(
      buildApprovalInteractionRecord({
        approvalId: "approval-1",
        responseId: "response-1",
        status: "resolved",
        workItem,
      }),
    ).toEqual({
      category: "approval",
      approvalId: "approval-1",
      responseId: "response-1",
      status: "resolved",
      workItem,
    })

    expect(
      buildApprovalInteractionRecord({
        approvalId: "approval-1",
        staleReason: "expired_interaction",
        status: "stale",
        workItem,
      }),
    ).toEqual({
      category: "approval",
      approvalId: "approval-1",
      staleReason: "expired_interaction",
      status: "stale",
      workItem,
    })
  })

  test("clarifies choice and choice_group as elicitation subtypes with stable linkage", () => {
    const workItem = {
      queueItemId: "queue-1",
      threadId: "thread-1",
    }

    expect(
      buildElicitationInteractionRecord({
        elicitationKind: "choice",
        interactionId: "interaction-1",
        status: "requested",
        workItem,
      }),
    ).toEqual({
      category: "elicitation",
      elicitationKind: "choice",
      interactionId: "interaction-1",
      status: "requested",
      workItem,
    })

    expect(
      buildElicitationInteractionRecord({
        elicitationKind: "choice_group",
        interactionId: "interaction-1",
        responseId: "response-1",
        status: "responded",
        workItem,
      }),
    ).toEqual({
      category: "elicitation",
      elicitationKind: "choice_group",
      interactionId: "interaction-1",
      responseId: "response-1",
      status: "responded",
      workItem,
    })

    expect(
      buildElicitationInteractionRecord({
        elicitationKind: "elicitation",
        interactionId: "interaction-1",
        responseId: "response-1",
        status: "resolved",
        workItem,
      }),
    ).toEqual({
      category: "elicitation",
      elicitationKind: "elicitation",
      interactionId: "interaction-1",
      responseId: "response-1",
      status: "resolved",
      workItem,
    })

    expect(
      buildElicitationInteractionRecord({
        elicitationKind: "choice",
        interactionId: "interaction-1",
        staleReason: "stale_interaction",
        status: "stale",
        workItem,
      }),
    ).toEqual({
      category: "elicitation",
      elicitationKind: "choice",
      interactionId: "interaction-1",
      staleReason: "stale_interaction",
      status: "stale",
      workItem,
    })
  })

  test("allows only extension namespaces under the 0000.chat prefix", () => {
    expect(validateZeroChatExtensionNamespace("0000.chat/elicitation")).toEqual({
      ok: true,
      namespace: "0000.chat/elicitation",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat/extensions/correlation_v1")).toEqual({
      ok: true,
      namespace: "0000.chat/extensions/correlation_v1",
    })
    expect(validateZeroChatExtensionNamespace(" 0000.chat/tools/fs.read ")).toEqual({
      ok: true,
      namespace: "0000.chat/tools/fs.read",
    })
  })

  test("denies ambiguous, foreign, or malformed extension namespaces", () => {
    expect(validateZeroChatExtensionNamespace(undefined)).toEqual({
      ok: false,
      reason: "missing_namespace",
    })
    expect(validateZeroChatExtensionNamespace(" ")).toEqual({
      ok: false,
      reason: "missing_namespace",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat")).toEqual({
      ok: false,
      reason: "missing_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat/")).toEqual({
      ok: false,
      reason: "missing_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat//elicitation")).toEqual({
      ok: false,
      reason: "malformed_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat/../secrets")).toEqual({
      ok: false,
      reason: "malformed_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat/./elicitation")).toEqual({
      ok: false,
      reason: "malformed_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat/elicitation?token=secret")).toEqual({
      ok: false,
      reason: "malformed_extension_path",
    })
    expect(validateZeroChatExtensionNamespace("0000.chat.local/elicitation")).toEqual({
      ok: false,
      reason: "foreign_namespace",
    })
    expect(validateZeroChatExtensionNamespace("acp/elicitation")).toEqual({
      ok: false,
      reason: "foreign_namespace",
    })
  })

  test("redacts sensitive correlation metadata while preserving routing identifiers", () => {
    expect(
      redactCorrelationMetadata({
        bridgeTraceId: "trace-123",
        organizationId: "org-1",
        queueItemId: "queue-456",
        sessionKey: "session-789",
        threadId: "thread-abc",
        authorization: "Bearer secret-token",
        prompt: "raw user prompt",
        nested: {
          apiKey: "sk-secret",
          model: "gpt-5",
          messages: ["raw message"],
        },
      }),
    ).toEqual({
      bridgeTraceId: "trace-123",
      organizationId: "org-1",
      queueItemId: "queue-456",
      sessionKey: "session-789",
      threadId: "thread-abc",
      authorization: "[redacted]",
      prompt: "[redacted]",
      nested: {
        apiKey: "[redacted]",
        model: "gpt-5",
        messages: "[redacted]",
      },
    })
  })

  test("redacts unsafe metadata values inside arrays without mutating the original input", () => {
    const metadata = {
      attempts: [
        { interactionId: "interaction-1", token: "secret" },
        { extensionNamespace: "0000.chat/elicitation" },
      ],
      safe: true,
    }

    const redacted = redactCorrelationMetadata(metadata)

    expect(redacted).toEqual({
      attempts: [
        { interactionId: "interaction-1", token: "[redacted]" },
        { extensionNamespace: "0000.chat/elicitation" },
      ],
      safe: true,
    })
    expect(metadata.attempts[0]?.token).toBe("secret")
  })

  test("redacts key-like values across nested arrays and objects", () => {
    expect(
      redactCorrelationMetadata({
        route: {
          bridgeTraceId: "trace-123",
          threadId: "thread-1",
        },
        credentials: [
          {
            accessToken: "access-token",
            nested: [{ clientSecret: "client-secret" }],
          },
          {
            password: "password",
            authHeader: "Bearer abc",
          },
        ],
        api_key: "api-key",
        publicKeyFingerprint: "fingerprint-1",
        content: {
          rawPrompt: "raw prompt",
          summary: "safe summary",
        },
      }),
    ).toEqual({
      route: {
        bridgeTraceId: "trace-123",
        threadId: "thread-1",
      },
      credentials: [
        {
          accessToken: "[redacted]",
          nested: [{ clientSecret: "[redacted]" }],
        },
        {
          password: "[redacted]",
          authHeader: "[redacted]",
        },
      ],
      api_key: "[redacted]",
      publicKeyFingerprint: "[redacted]",
      content: {
        rawPrompt: "[redacted]",
        summary: "safe summary",
      },
    })
  })
})

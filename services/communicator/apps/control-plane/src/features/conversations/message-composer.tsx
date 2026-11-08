import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  apiClient,
  isDefinitiveRequestRejection,
} from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

function makeIdempotencyKey() {
  return `ui-${globalThis.crypto.randomUUID()}`;
}

export type MessageComposerProps = {
  identityId: string;
  conversationId: string;
  canSend: boolean;
  unavailableReason?: string;
};

export function MessageComposer({
  identityId,
  conversationId,
  canSend,
  unavailableReason,
}: MessageComposerProps) {
  const queryClient = useQueryClient();
  const idempotencyKey = useRef<string | null>(null);
  const [body, setBody] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"direct" | "paced">(
    "direct",
  );
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      apiClient.sendMessage({
        conversationId,
        identityId,
        body: body.trim(),
        deliveryMode,
        idempotencyKey:
          idempotencyKey.current ??
          (idempotencyKey.current = makeIdempotencyKey()),
      }),
    onMutate: () => setResultMessage(null),
    onSuccess: (command) => {
      idempotencyKey.current = null;
      setBody("");
      switch (command.status) {
        case "accepted":
          setResultMessage("Accepted — awaiting messaging confirmation");
          break;
        case "submitted_to_matrix":
          setResultMessage(
            "Submitted to messaging service — delivery not confirmed",
          );
          break;
        case "matrix_confirmed":
        case "bridged":
          setResultMessage(
            "Messaging service accepted — provider delivery not confirmed",
          );
          break;
        case "delivered":
          setResultMessage("Delivered — confirmed by provider evidence");
          break;
        case "delivery_uncertain":
          setResultMessage(
            "Delivery uncertain — review Activity before any deliberate resend.",
          );
          break;
        default:
          setResultMessage(
            `Command saved (${command.status}) — review Activity for its current state.`,
          );
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.commands(identityId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.commands(),
      });
    },
    onError: (error) => {
      if (isDefinitiveRequestRejection(error)) {
        idempotencyKey.current = null;
      }
      setResultMessage(
        error instanceof ApiError && error.code === "chat_paused"
          ? "This chat is paused while delivery remains uncertain. Review Activity to choose cancel, continue, or deliberate resend."
          : isDefinitiveRequestRejection(error)
            ? "Request rejected — no new command accepted. Review the request and your permissions."
            : "Acceptance uncertain — check Activity before retrying. Retrying reuses the same key and may submit the original message if it was not accepted.",
      );
    },
  });

  const isDisabled = mutation.isPending || !canSend;
  const acceptanceUncertain =
    mutation.isError && !isDefinitiveRequestRejection(mutation.error);
  const canSubmit =
    body.trim().length > 0 && deliveryMode === "direct" && !isDisabled;

  return (
    <form
      aria-label="Send a message"
      className="grid gap-3 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) mutation.mutate();
      }}
    >
      <div className="grid gap-2">
        <label
          htmlFor="message-body"
          className="text-xs font-semibold text-muted-foreground"
        >
          Message
        </label>
        <Textarea
          id="message-body"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            setResultMessage(null);
          }}
          placeholder="Write a message"
          disabled={isDisabled || acceptanceUncertain}
        />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <label
            htmlFor="delivery-mode"
            className="text-xs font-semibold text-muted-foreground"
          >
            Delivery mode
          </label>
          <select
            id="delivery-mode"
            aria-label="Delivery mode"
            value={deliveryMode}
            onChange={(event) => {
              if (
                event.target.value === "direct" ||
                event.target.value === "paced"
              ) {
                setDeliveryMode(event.target.value);
                setResultMessage(null);
              }
            }}
            disabled={isDisabled || acceptanceUncertain}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="direct">Direct</option>
            <option value="paced">Human-paced (unavailable)</option>
          </select>
        </div>
        <Button type="submit" disabled={!canSubmit}>
          {mutation.isPending
            ? "Submitting request…"
            : acceptanceUncertain
              ? "Retry same request"
              : "Send message"}
        </Button>
      </div>
      {deliveryMode === "paced" && (
        <div className="border-l-2 border-primary/40 pl-3 text-sm">
          <p className="font-semibold">Human pacing is unavailable</p>
          <p className="mt-2 text-muted-foreground">
            Nothing will be sent in this mode. Select Direct to send without
            reading delays or typing simulation.
          </p>
        </div>
      )}
      {!canSend && unavailableReason && (
        <p className="text-sm text-muted-foreground">{unavailableReason}</p>
      )}
      {resultMessage && (
        <p role="status" className="text-sm">
          {resultMessage}
        </p>
      )}
    </form>
  );
}

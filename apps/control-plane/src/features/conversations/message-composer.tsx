import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiClient, isDefinitiveRequestRejection } from "@/lib/api/client";
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
    onSuccess: () => {
      idempotencyKey.current = null;
      setBody("");
      setResultMessage("Accepted — awaiting messaging confirmation");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.commands(identityId),
      });
    },
    onError: (error) => {
      if (isDefinitiveRequestRejection(error)) {
        idempotencyKey.current = null;
      }
      setResultMessage("The simulated command could not be accepted.");
    },
  });

  const isDisabled = mutation.isPending || !canSend;
  const canSubmit = body.trim().length > 0 && !isDisabled;

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
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a simulated message"
          disabled={isDisabled}
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
            onChange={(event) =>
              setDeliveryMode(event.target.value as "direct" | "paced")
            }
            disabled={isDisabled}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="direct">Direct</option>
            <option value="paced">Human-paced</option>
          </select>
        </div>
        <Button type="submit" disabled={!canSubmit}>
          Send message
        </Button>
      </div>
      {deliveryMode === "paced" && (
        <div className="border-l-2 border-primary/40 pl-3 text-sm">
          <p className="font-semibold">Human-paced preview</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Mark read (when supported)</li>
            <li>Reading delay</li>
            <li>Typing indicator</li>
            <li>Send message</li>
          </ol>
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

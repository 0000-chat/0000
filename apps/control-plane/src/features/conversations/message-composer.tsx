import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

function makeIdempotencyKey() {
  return `ui-${globalThis.crypto.randomUUID()}`;
}

export function MessageComposer({ identityId, conversationId }: {
  identityId: string;
  conversationId: string;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"direct" | "paced">("direct");
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => apiClient.sendMessage({
      conversationId,
      identityId,
      body: body.trim(),
      deliveryMode,
      idempotencyKey: makeIdempotencyKey(),
    }),
    onSuccess: () => {
      setBody("");
      setResultMessage("Accepted — awaiting messaging confirmation");
      void queryClient.invalidateQueries({ queryKey: queryKeys.commands(identityId) });
    },
    onError: () => setResultMessage("The simulated command could not be accepted."),
  });

  const isDisabled = mutation.isPending;
  const canSubmit = body.trim().length > 0 && !isDisabled;

  return (
    <form
      aria-label="Send a message"
      className="rounded-xl border bg-card p-4 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) mutation.mutate();
      }}
    >
      <div className="grid gap-2">
        <label htmlFor="message-body" className="text-sm font-medium">Message</label>
        <Textarea
          id="message-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write a simulated message"
          disabled={isDisabled}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <label htmlFor="delivery-mode" className="text-sm font-medium">Delivery mode</label>
          <select
            id="delivery-mode"
            aria-label="Delivery mode"
            value={deliveryMode}
            onChange={(event) => setDeliveryMode(event.target.value as "direct" | "paced")}
            disabled={isDisabled}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="direct">Direct</option>
            <option value="paced">Human-paced</option>
          </select>
        </div>
        <Button type="submit" disabled={!canSubmit}>Send message</Button>
      </div>
      {deliveryMode === "paced" && (
        <div className="mt-4 rounded-lg border border-dashed p-3 text-sm">
          <p className="font-semibold">Human-paced preview</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Mark read (when supported)</li>
            <li>Reading delay</li>
            <li>Typing indicator</li>
            <li>Send message</li>
          </ol>
        </div>
      )}
      {resultMessage && <p role="status" className="mt-3 text-sm">{resultMessage}</p>}
    </form>
  );
}

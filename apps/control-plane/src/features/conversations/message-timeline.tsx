import type { Message } from "@communicator/contracts";

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function attachmentLabel(count: number) {
  return `${count} attachment${count === 1 ? "" : "s"}`;
}

function deliveryLabel(status: Message["delivery_status"]) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function MessageTimeline({ messages }: { messages: Message[] }) {
  return (
    <ol aria-label="Message timeline" className="grid gap-4">
      {messages.map((message) => (
        <li key={message.id} className={message.direction === "outbound" ? "text-right" : "text-left"}>
          <article className="inline-block max-w-[min(42rem,100%)] rounded-xl border bg-card p-4 text-left shadow-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{message.sender_label}</span>
              <span aria-label={`Delivery status: ${message.delivery_status}`}>
                {deliveryLabel(message.delivery_status)}
              </span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words">{message.body}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <time dateTime={message.occurred_at}>{formatTimestamp(message.occurred_at)}</time>
              <span>{attachmentLabel(message.attachment_count)}</span>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}

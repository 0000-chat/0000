import type { Message, MessagePageResult } from "@communicator/contracts";

export function chronologicalMessages(
  pages: readonly MessagePageResult[],
): Message[] {
  const seen = new Set<string>();
  const newestFirst = pages
    .flatMap((page) => page.items)
    .filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  return newestFirst.reverse();
}

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
  return status
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function MessageTimeline({
  messages,
  selectedMessageId,
}: {
  messages: Message[];
  selectedMessageId?: string;
}) {
  return (
    <ol aria-label="Message timeline" className="grid gap-3 p-4">
      {messages.map((message) => (
        <li
          key={message.id}
          id={message.id}
          aria-current={message.id === selectedMessageId ? "true" : undefined}
          className={`${message.direction === "outbound" ? "text-right" : "text-left"} ${message.id === selectedMessageId ? "rounded-2xl ring-2 ring-primary ring-offset-2" : ""}`}
        >
          <article className="inline-block max-w-[min(42rem,100%)] rounded-2xl border bg-card px-3.5 py-2.5 text-left">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                {message.sender_label}
              </span>
              <span aria-label={`Delivery status: ${message.delivery_status}`}>
                {deliveryLabel(message.delivery_status)}
              </span>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap break-words">
              {message.body}
            </p>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <time dateTime={message.occurred_at}>
                {formatTimestamp(message.occurred_at)}
              </time>
              <span>{attachmentLabel(message.attachment_count)}</span>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}

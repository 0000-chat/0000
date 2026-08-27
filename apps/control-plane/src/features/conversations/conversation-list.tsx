import { Link } from "@tanstack/react-router";
import type { ConversationSummary } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  return (
    <ul aria-label="Conversation inbox" className="grid gap-3">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <Link
            to="/conversations/$conversationId"
            params={{ conversationId: conversation.id }}
            className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{conversation.title}</h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {conversation.last_message_preview}
                </p>
              </div>
              {conversation.unread_count > 0 && (
                <Badge aria-label={`${conversation.unread_count} unread`}>
                  {conversation.unread_count}
                </Badge>
              )}
            </div>
            <time
              dateTime={conversation.last_activity_at}
              className="mt-3 block text-xs text-muted-foreground"
            >
              {formatTimestamp(conversation.last_activity_at)}
            </time>
          </Link>
        </li>
      ))}
    </ul>
  );
}

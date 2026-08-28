import { Link } from "@tanstack/react-router";
import type { ChannelSummary, ConversationSummary } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export type ConversationListProps = {
  conversations: ConversationSummary[];
  channelsById: ReadonlyMap<string, ChannelSummary>;
  identityId: string;
  selectedChannelId?: string;
  activeConversationId?: string;
};

export function ConversationList({
  conversations,
  channelsById,
  identityId,
  selectedChannelId,
  activeConversationId,
}: ConversationListProps) {
  return (
    <ul aria-label="Conversation inbox" className="grid gap-3">
      {conversations.map((conversation) => {
        const channel = channelsById.get(conversation.connection_id);
        if (!channel) {
          return (
            <li key={conversation.id} data-testid="conversation-row" data-conversation-id={conversation.id}>
              <p role="alert" className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                This conversation is unavailable.
              </p>
            </li>
          );
        }
        return (
          <li key={conversation.id}>
            <Link
              to="/conversations/$conversationId"
              params={{ conversationId: conversation.id }}
              search={{ identity: identityId, ...(selectedChannelId ? { channel: selectedChannelId } : {}) }}
              data-testid="conversation-row"
              data-conversation-id={conversation.id}
              data-channel-id={channel.id}
              aria-current={activeConversationId === conversation.id ? "page" : undefined}
              className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{conversation.title}</h2>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {channel.provider} · {channel.display_label}
                  </p>
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
        );
      })}
    </ul>
  );
}

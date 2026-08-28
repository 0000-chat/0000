import { Link } from "@tanstack/react-router";
import type { ChannelSummary, ConversationSummary } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";
import { ProviderIcon } from "./provider-icon";

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString("en-NZ", {
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
    <ul aria-label="Conversation inbox" className="divide-y divide-border/70">
      {conversations.map((conversation) => {
        const channel = channelsById.get(conversation.connection_id);
        if (!channel) {
          return (
            <li key={conversation.id} data-testid="conversation-row" data-conversation-id={conversation.id}>
              <p role="alert" className="px-4 py-4 text-sm text-muted-foreground">
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
              className="group flex min-h-[4.5rem] items-start gap-3 px-4 py-3 transition-colors hover:bg-accent hover:text-accent-foreground aria-[current=page]:bg-accent/70"
            >
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <ProviderIcon provider={channel.provider} className="size-4.5" />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="flex min-w-0 items-center gap-2">
                  <h2 className="truncate text-sm font-semibold">{conversation.title}</h2>
                  {conversation.unread_count > 0 && (
                    <Badge aria-label={`${conversation.unread_count} unread`}>{conversation.unread_count}</Badge>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <span className="capitalize">{channel.provider}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{channel.display_label}</span>
                </span>
                <span className="truncate text-sm text-muted-foreground group-hover:text-accent-foreground/80">
                  {conversation.last_message_preview}
                </span>
              </span>
              <time
                dateTime={conversation.last_activity_at}
                className="shrink-0 pt-0.5 text-[11px] text-muted-foreground"
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

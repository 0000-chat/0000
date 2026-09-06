import { Link } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ChannelSummary, ConversationSummary, Identity } from "@communicator/contracts";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { MessageComposer } from "./message-composer";
import { MessageTimeline } from "./message-timeline";
import { ProviderIcon } from "./provider-icon";

export type ConversationPageProps = {
  identity: Identity;
  channel: ChannelSummary;
  conversation: ConversationSummary;
  selectedChannelId?: string;
};

export function ConversationUnavailable({ identityId }: { identityId: string }) {
  return (
    <section role="alert" className="space-y-3 p-6" aria-live="polite">
      <p>This conversation is unavailable.</p>
      <Link
        to="/conversations"
        search={{ identity: identityId }}
        className="text-primary underline"
      >
        Return to All
      </Link>
    </section>
  );
}

export function ConversationPage({
  identity,
  channel,
  conversation,
  selectedChannelId,
}: ConversationPageProps) {
  const navigate = useNavigate();
  const isSafe = conversation.identity_id === identity.id
    && conversation.connection_id === channel.id
    && channel.identity_id === identity.id
    && conversation.tenant_id === channel.tenant_id
    && (!selectedChannelId || selectedChannelId === conversation.connection_id);
  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(identity.id, conversation.id),
    queryFn: () => apiClient.getMessages(conversation.id, identity.id),
    enabled: isSafe,
  });

  if (!isSafe) return <ConversationUnavailable identityId={identity.id} />;

  const canSend = channel.status === "ready" && channel.capabilities.includes("message.send");

  return (
    <section className="flex h-full min-h-0 flex-col" aria-labelledby="conversation-title">
      <header className="sticky top-0 z-[1] flex min-h-16 shrink-0 items-center gap-3 border-b px-4">
        <button
          type="button"
          className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          aria-label="Back to conversations"
          onClick={() => void navigate({
            to: "/conversations",
            search: {
              identity: identity.id,
              ...(selectedChannelId ? { channel: selectedChannelId } : {}),
            },
          })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ProviderIcon provider={channel.provider} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {identity.display_name} · {channel.provider} · {channel.display_label}
          </p>
          <h1 id="conversation-title" className="truncate text-base font-semibold">{conversation.title}</h1>
        </div>
        {conversation.unread_count > 0 && <Badge>{conversation.unread_count} unread</Badge>}
      </header>
      <div data-testid="message-viewport" className="min-h-0 flex-1 overflow-y-auto">
        {messagesQuery.isLoading && <p role="status" className="p-4 text-sm text-muted-foreground">Loading messages…</p>}
        {messagesQuery.isError && (
          <div role="alert" className="space-y-3 p-4 text-sm">
            <p>Unable to load messages.</p>
            <button type="button" className="text-primary underline" onClick={() => void messagesQuery.refetch()}>
              Retry
            </button>
          </div>
        )}
        {messagesQuery.data && <MessageTimeline messages={messagesQuery.data} />}
      </div>
      <div className="shrink-0 border-t bg-background/95">
        <MessageComposer
          identityId={identity.id}
          conversationId={conversation.id}
          canSend={canSend}
          {...(!canSend
            ? { unavailableReason: "Sending is unavailable until this connection is repaired." }
            : {})}
        />
      </div>
    </section>
  );
}

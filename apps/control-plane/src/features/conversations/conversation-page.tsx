import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ChannelSummary, ConversationSummary, Identity } from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { MessageComposer } from "./message-composer";
import { MessageTimeline } from "./message-timeline";

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
    <section className="space-y-6 p-6">
      <div>
        <Link
          to="/conversations"
          search={{
            identity: identity.id,
            ...(selectedChannelId ? { channel: selectedChannelId } : {}),
          }}
          className="text-sm text-primary underline"
        >
          Back to conversations
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div>
            <p className="text-sm text-muted-foreground">
              {identity.display_name} · {channel.provider} · {channel.display_label}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{conversation.title}</h1>
          </div>
          {conversation.unread_count > 0 && <Badge>{conversation.unread_count} unread</Badge>}
        </div>
      </div>
      {messagesQuery.isLoading && <p role="status">Loading messages…</p>}
      {messagesQuery.isError && (
        <div role="alert" className="space-y-3">
          <p>Unable to load messages.</p>
          <button type="button" className="text-primary underline" onClick={() => void messagesQuery.refetch()}>
            Retry
          </button>
        </div>
      )}
      {messagesQuery.data && <MessageTimeline messages={messagesQuery.data} />}
      <MessageComposer
        identityId={identity.id}
        conversationId={conversation.id}
        canSend={canSend}
        {...(!canSend
          ? { unavailableReason: "Sending is unavailable until this connection is repaired." }
          : {})}
      />
    </section>
  );
}

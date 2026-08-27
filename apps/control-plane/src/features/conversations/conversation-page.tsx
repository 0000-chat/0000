import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { MessageComposer } from "./message-composer";
import { MessageTimeline } from "./message-timeline";

export function ConversationPage() {
  const { conversationId } = useParams({ from: "/conversations/$conversationId" });
  const { activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const conversationsQuery = useQuery({
    queryKey: queryKeys.conversations(identityId),
    queryFn: () => apiClient.getConversations(identityId),
    enabled: Boolean(identityId),
  });
  const conversation = conversationsQuery.data?.find((item) => item.id === conversationId);
  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(identityId, conversationId),
    queryFn: () => apiClient.getMessages(conversationId, identityId),
    enabled: Boolean(identityId && conversation && !conversationsQuery.isLoading),
  });

  if (identityLoading || conversationsQuery.isLoading) {
    return <p role="status" className="text-sm text-muted-foreground">Loading conversation…</p>;
  }

  if (!conversation) {
    return (
      <section className="space-y-3" aria-live="polite">
        <h1 className="text-3xl font-semibold tracking-tight">Conversation not found</h1>
        <p className="text-muted-foreground">This conversation is not available for the active identity.</p>
        <Link to="/conversations" className="text-primary underline">Back to conversations</Link>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div>
        <Link to="/conversations" className="text-sm text-primary underline">Back to conversations</Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Identity-scoped conversation</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{conversation.title}</h1>
          </div>
          {conversation.unread_count > 0 && <Badge>{conversation.unread_count} unread</Badge>}
        </div>
      </div>
      {messagesQuery.isLoading && <p role="status">Loading messages…</p>}
      {messagesQuery.data && <MessageTimeline messages={messagesQuery.data} />}
      <MessageComposer identityId={identityId} conversationId={conversation.id} />
    </section>
  );
}

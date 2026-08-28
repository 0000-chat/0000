import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { ConversationList } from "@/features/conversations/conversation-list";

function ConversationsRoute() {
  const { activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const { data: conversationsPage, isLoading } = useQuery({
    queryKey: queryKeys.conversations(identityId, undefined),
    queryFn: () => apiClient.getConversations(identityId, undefined),
    enabled: Boolean(identityId),
  });
  const conversations = conversationsPage?.items ?? [];

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Identity-scoped inbox</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Conversations</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Browse conversations available to the selected identity.
        </p>
      </div>
      {(identityLoading || isLoading) && <p role="status">Loading conversations…</p>}
      {!identityLoading && !isLoading && conversations.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No conversations are available for this identity.
        </p>
      )}
      <ConversationList conversations={conversations} />
    </section>
  );
}

export const Route = createFileRoute("/conversations/")({ component: ConversationsRoute });

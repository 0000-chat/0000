import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ConversationPageResult } from "@communicator/contracts";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import {
  applyChannelOrder,
  loadChannelOrder,
  saveChannelOrder,
} from "./channel-order";
import { ChannelSelector } from "./channel-selector";
import { ChannelSidebar } from "./channel-sidebar";
import { ConversationList } from "./conversation-list";
import { ConversationPage, ConversationUnavailable } from "./conversation-page";

export function ConversationsShell({ conversationId }: { conversationId?: string }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const selectedChannelId = search.channel;
  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiClient.getMe(),
  });
  const channelsQuery = useQuery({
    queryKey: queryKeys.channels(identityId),
    queryFn: () => apiClient.getChannels(identityId),
    enabled: Boolean(identityId),
  });
  const [preferredChannelIds, setPreferredChannelIds] = useState<string[]>([]);

  useEffect(() => {
    if (meQuery.data && identityId) {
      setPreferredChannelIds(loadChannelOrder(meQuery.data.principal_id, identityId));
    }
  }, [identityId, meQuery.data]);

  const channels = useMemo(
    () => applyChannelOrder(channelsQuery.data ?? [], preferredChannelIds),
    [channelsQuery.data, preferredChannelIds],
  );
  const channelsById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  );
  const allConversationsQuery = useConversationPages(identityId, undefined, Boolean(identityId));
  const selectedConversationsQuery = useConversationPages(
    identityId,
    selectedChannelId,
    Boolean(identityId && selectedChannelId),
  );
  const activeConversationQuery = useQuery({
    queryKey: queryKeys.conversation(identityId, conversationId ?? ""),
    queryFn: () => apiClient.getConversation(identityId, conversationId ?? ""),
    enabled: Boolean(identityId && conversationId),
  });
  const conversationsQuery = selectedChannelId ? selectedConversationsQuery : allConversationsQuery;
  const conversations = conversationsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const allUnreadCount = channels.reduce((sum, channel) => sum + channel.unread_count, 0);
  const selectedChannel = selectedChannelId ? channelsById.get(selectedChannelId) : undefined;
  const activeThread = activeConversationQuery.data
    ? (() => {
      const channel = channelsById.get(activeConversationQuery.data.connection_id);
      if (!channel) return null;
      if (
        activeConversationQuery.data.identity_id !== activeIdentity?.id
        || activeConversationQuery.data.connection_id !== channel.id
        || channel.identity_id !== activeIdentity?.id
        || activeConversationQuery.data.tenant_id !== channel.tenant_id
        || (selectedChannelId !== undefined && selectedChannelId !== activeConversationQuery.data.connection_id)
      ) {
        return null;
      }
      return { channel, conversation: activeConversationQuery.data };
    })()
    : null;

  const selectChannel = (channelId?: string) => {
    void navigate({
      to: "/conversations",
      search: {
        identity: identityId,
        ...(channelId ? { channel: channelId } : {}),
      },
    });
  };

  const reorderChannels = (orderedIds: string[]) => {
    if (!meQuery.data || !identityId) return;
    saveChannelOrder(meQuery.data.principal_id, identityId, orderedIds);
    setPreferredChannelIds(orderedIds);
  };

  const channelNavigation = (
    <ChannelSidebar
      channels={channels}
      identityId={identityId}
      {...(selectedChannelId ? { selectedChannelId } : {})}
      allUnreadCount={allUnreadCount}
      onSelect={selectChannel}
      onReorder={reorderChannels}
    />
  );

  if (identityLoading || !activeIdentity) {
    return <p role="status">Loading identity…</p>;
  }
  if (channelsQuery.isLoading) {
    return <p role="status">Loading channels…</p>;
  }
  if (channelsQuery.isError) {
    return (
      <div role="alert" className="space-y-3">
        <p>Unable to load channels.</p>
        <Button type="button" onClick={() => void channelsQuery.refetch()}>Retry</Button>
      </div>
    );
  }
  if (channels.length === 0) {
    return <p role="status">No channels are available for this identity.</p>;
  }

  const conversationError = conversationsQuery.isError && conversations.length === 0;
  const emptyMessage = selectedChannelId
    ? "No conversations are available for this channel."
    : "No conversations are available.";

  return (
    <section aria-labelledby="conversations-heading" className="min-h-[calc(100vh-8rem)]">
      <h1 id="conversations-heading" className="sr-only">Conversations</h1>
      <div className="mb-3 md:hidden">
        <ChannelSelector label={selectedChannel?.display_label ?? "All"}>{channelNavigation}</ChannelSelector>
      </div>
      <div className="grid min-h-[38rem] overflow-hidden rounded-xl border bg-card md:grid-cols-[14rem_minmax(18rem,22rem)_minmax(0,1fr)]">
        <aside className="hidden border-r bg-muted/30 md:block">{channelNavigation}</aside>
        <div className={conversationId ? "hidden border-r md:block" : "border-r"}>
          <div className="border-b p-4">
            <p className="text-sm font-medium text-muted-foreground">{activeIdentity.display_name}</p>
            <h2 className="text-lg font-semibold">{selectedChannel?.display_label ?? "All conversations"}</h2>
          </div>
          {conversationError && (
            <div role="alert" className="m-3 space-y-2 rounded-lg border border-destructive/40 p-3 text-sm">
              <p>Unable to load conversations.</p>
              <Button type="button" size="sm" onClick={() => void conversationsQuery.refetch()}>Retry</Button>
            </div>
          )}
          {conversationsQuery.isLoading && <p role="status" className="p-4 text-sm">Loading conversations…</p>}
          {!conversationsQuery.isLoading && conversations.length === 0 && !conversationError && (
            <p role="status" className="p-4 text-sm text-muted-foreground">{emptyMessage}</p>
          )}
          <div className="p-3">
            <ConversationList
              conversations={conversations}
              channelsById={channelsById}
              identityId={identityId}
              {...(selectedChannelId ? { selectedChannelId } : {})}
              {...(conversationId ? { activeConversationId: conversationId } : {})}
            />
            {conversationsQuery.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full"
                disabled={conversationsQuery.isFetchingNextPage}
                onClick={() => void conversationsQuery.fetchNextPage()}
              >
                {conversationsQuery.isFetchingNextPage ? "Loading older conversations…" : "Load older conversations"}
              </Button>
            )}
          </div>
        </div>
        <main className="min-w-0">
          {conversationId && activeConversationQuery.isLoading && (
            <p role="status" className="p-6 text-sm text-muted-foreground">Loading conversation…</p>
          )}
          {conversationId && !activeConversationQuery.isLoading && !activeThread && (
            <ConversationUnavailable identityId={activeIdentity.id} />
          )}
          {conversationId && activeThread && (
            <ConversationPage
              identity={activeIdentity}
              channel={activeThread.channel}
              conversation={activeThread.conversation}
              {...(selectedChannelId ? { selectedChannelId } : {})}
            />
          )}
          {!conversationId && (
            <div className="flex min-h-[38rem] items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Select a conversation to view its messages.
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

function useConversationPages(identityId: string, channelId: string | undefined, enabled: boolean) {
  return useInfiniteQuery<ConversationPageResult, Error, { pages: ConversationPageResult[]; pageParams: Array<string | null> }, readonly ["conversations", string, string], string | null>({
    queryKey: queryKeys.conversations(identityId, channelId),
    queryFn: ({ pageParam }) => apiClient.getConversations(identityId, channelId, pageParam ?? undefined),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled,
  });
}

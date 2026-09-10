import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ChannelSummary, ConversationPageResult } from "@communicator/contracts";
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
import { prepareConversationEvent } from "./apply-conversation-event";
import { runtimeRealtimeClient } from "@/lib/realtime/runtime-client";

export function ConversationsShell({ conversationId }: { conversationId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search } = useLocation();
  const { session, activeIdentity, isLoading: identityLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const selectedChannelId = search.channel;
  const channelsQuery = useQuery({
    queryKey: queryKeys.channels(identityId),
    queryFn: () => apiClient.getChannels(identityId),
    enabled: Boolean(identityId),
  });
  const [preferredChannelIds, setPreferredChannelIds] = useState<string[]>([]);

  useEffect(() => {
    if (session && identityId) {
      setPreferredChannelIds(loadChannelOrder(session.principal.id, identityId));
    }
  }, [identityId, session]);

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
  const acceptedSequenceRef = useRef(0);
  const activeScopeRef = useRef({ tenantId: activeIdentity?.tenant_id ?? "", identityId });
  activeScopeRef.current = { tenantId: activeIdentity?.tenant_id ?? "", identityId };

  useEffect(() => {
    acceptedSequenceRef.current = 0;
  }, [activeIdentity?.tenant_id, identityId]);

  useEffect(() => {
    if (!runtimeRealtimeClient || !identityId) return;
    void runtimeRealtimeClient.connect();
    const unsubscribe = runtimeRealtimeClient.subscribe((event) => {
      const currentScope = activeScopeRef.current;
      if (currentScope.identityId !== identityId || currentScope.tenantId !== (activeIdentity?.tenant_id ?? "")) {
        return;
      }
      const update = prepareConversationEvent({
        tenantId: currentScope.tenantId,
        identityId: currentScope.identityId,
        lastSequence: acceptedSequenceRef.current,
        channels,
      }, event);
      if (!update) return;
      acceptedSequenceRef.current = update.acceptedSequence;

      const updateConversationCache = (queryKey: ReturnType<typeof queryKeys.conversations>) => {
        let unsafe = false;
        queryClient.setQueryData<InfiniteData<ConversationPageResult>>(queryKey, (current) => {
          if (!current) return current;
          unsafe = current.pages.length > 1 || current.pages.some((page) => page.next_cursor !== null);
          if (unsafe) return current;
          const pages = update.updatePages(current.pages);
          return pages === current.pages ? current : { ...current, pages: pages ?? current.pages };
        });
        if (unsafe) void queryClient.invalidateQueries({ queryKey });
      };

      updateConversationCache(queryKeys.conversations(identityId, undefined));
      updateConversationCache(queryKeys.conversations(identityId, update.channelId));
      queryClient.setQueryData<ChannelSummary[]>(
        queryKeys.channels(identityId),
        update.updateChannels,
      );
    });
    return () => {
      unsubscribe();
    };
  }, [activeIdentity?.tenant_id, channels, identityId, queryClient]);

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
    if (!session || !identityId) return;
    saveChannelOrder(session.principal.id, identityId, orderedIds);
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
    <section aria-labelledby="conversations-heading" className="flex h-full min-h-0 flex-col overflow-hidden">
      <h1 id="conversations-heading" className="sr-only">Conversations</h1>
      {!conversationId && (
        <div className="shrink-0 border-b p-3 md:hidden">
          <ChannelSelector label={selectedChannel?.display_label ?? "All"}>{channelNavigation}</ChannelSelector>
        </div>
      )}
      <div
        data-testid="conversation-workspace"
        className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[15rem_minmax(18rem,22rem)_minmax(0,1fr)]"
      >
        <aside className="hidden min-h-0 overflow-hidden border-r bg-muted/20 md:block">{channelNavigation}</aside>
        <section
          aria-labelledby="conversation-list-heading"
          className={conversationId
            ? "hidden min-h-0 border-r md:flex md:flex-col"
            : "flex min-h-0 flex-col border-r"}
        >
          <header className="flex min-h-14 shrink-0 items-center justify-between border-b px-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {activeIdentity.display_name}
              </p>
              <h2 id="conversation-list-heading" className="truncate text-base font-semibold">
                {selectedChannel?.display_label ?? "All conversations"}
              </h2>
            </div>
            <span className="text-xs text-muted-foreground">{conversations.length}</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversationError && (
              <div role="alert" className="m-3 space-y-2 border border-destructive/40 p-3 text-sm">
                <p>Unable to load conversations.</p>
                <Button type="button" size="sm" onClick={() => void conversationsQuery.refetch()}>Retry</Button>
              </div>
            )}
            {conversationsQuery.isLoading && <p role="status" className="p-4 text-sm">Loading conversations…</p>}
            {!conversationsQuery.isLoading && conversations.length === 0 && !conversationError && (
              <p role="status" className="p-4 text-sm text-muted-foreground">{emptyMessage}</p>
            )}
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
                className="m-3 w-[calc(100%-1.5rem)]"
                disabled={conversationsQuery.isFetchingNextPage}
                onClick={() => void conversationsQuery.fetchNextPage()}
              >
                {conversationsQuery.isFetchingNextPage ? "Loading older conversations…" : "Load older conversations"}
              </Button>
            )}
            {conversationsQuery.isFetchNextPageError && (
              <div role="alert" className="m-3 space-y-2 border border-destructive/40 p-3 text-sm">
                <p>Unable to load older conversations.</p>
                <Button type="button" size="sm" onClick={() => void conversationsQuery.fetchNextPage()}>Retry</Button>
              </div>
            )}
          </div>
        </section>
        <section
          aria-label="Active conversation"
          className={conversationId ? "flex min-h-0 min-w-0" : "hidden min-h-0 min-w-0 md:flex"}
        >
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
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
              Select a conversation to view its messages.
            </div>
          )}
        </section>
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

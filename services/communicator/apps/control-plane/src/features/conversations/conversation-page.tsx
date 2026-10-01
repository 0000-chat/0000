import { Link } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  ChannelSummary,
  ConversationSummary,
  Identity,
} from "@communicator/contracts";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { MessageComposer } from "./message-composer";
import { chronologicalMessages, MessageTimeline } from "./message-timeline";
import { ProviderIcon } from "./provider-icon";
import { useIdentityContext } from "@/components/identity/identity-switcher";

export type ConversationPageProps = {
  identity: Identity;
  channel: ChannelSummary;
  conversation: ConversationSummary;
  selectedChannelId?: string;
  selectedMessageId?: string;
};

export function ConversationUnavailable({
  identityId,
}: {
  identityId: string;
}) {
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
  selectedMessageId,
}: ConversationPageProps) {
  const { authStatus } = useIdentityContext();
  const navigate = useNavigate();
  const isSafe =
    conversation.identity_id === identity.id &&
    conversation.connection_id === channel.id &&
    channel.identity_id === identity.id &&
    conversation.tenant_id === channel.tenant_id &&
    (!selectedChannelId || selectedChannelId === conversation.connection_id);
  const messagesQuery = useInfiniteQuery({
    queryKey: queryKeys.messages(identity.id, conversation.id),
    queryFn: ({ pageParam }) =>
      apiClient.getMessages(
        conversation.id,
        identity.id,
        pageParam ?? undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: isSafe && authStatus === "authenticated",
  });
  const loadedMessages = messagesQuery.data
    ? chronologicalMessages(messagesQuery.data.pages)
    : [];
  const targetedMessageQuery = useQuery({
    queryKey: [
      ...queryKeys.messages(identity.id, conversation.id),
      "target",
      selectedMessageId ?? "",
    ],
    queryFn: async () => {
      if (selectedMessageId === undefined) {
        throw new Error("targeted message query requires a message id");
      }
      const page = await apiClient.getMessages(
        conversation.id,
        identity.id,
        undefined,
        1,
        selectedMessageId,
      );
      return page.items[0] ?? null;
    },
    enabled:
      isSafe &&
      authStatus === "authenticated" &&
      selectedMessageId !== undefined,
  });
  const selectedMessage =
    selectedMessageId !== undefined && targetedMessageQuery.isSuccess
      ? (targetedMessageQuery.data ?? undefined)
      : undefined;
  const messagesWithoutTarget =
    selectedMessageId === undefined
      ? loadedMessages
      : loadedMessages.filter((message) => message.id !== selectedMessageId);
  const messages = selectedMessage
    ? [...messagesWithoutTarget, selectedMessage].toSorted(
        (left, right) =>
          Date.parse(left.occurred_at) - Date.parse(right.occurred_at) ||
          left.id.localeCompare(right.id),
      )
    : messagesWithoutTarget;

  if (!isSafe) return <ConversationUnavailable identityId={identity.id} />;

  const canSend =
    authStatus === "authenticated" &&
    channel.status === "ready" &&
    channel.capabilities.includes("message.send");

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-labelledby="conversation-title"
    >
      <header className="sticky top-0 z-[1] flex min-h-16 shrink-0 items-center gap-3 border-b px-4">
        <button
          type="button"
          className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          aria-label="Back to conversations"
          onClick={() =>
            void navigate({
              to: "/conversations",
              search: {
                identity: identity.id,
                ...(selectedChannelId ? { channel: selectedChannelId } : {}),
              },
            })
          }
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <ProviderIcon provider={channel.provider} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">
            {identity.display_name} · {channel.provider} ·{" "}
            {channel.display_label}
          </p>
          <h1
            id="conversation-title"
            className="truncate text-base font-semibold"
          >
            {conversation.title}
          </h1>
        </div>
        {conversation.unread_count > 0 && (
          <Badge>{conversation.unread_count} unread</Badge>
        )}
      </header>
      <div
        data-testid="message-viewport"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {messagesQuery.isLoading && (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading messages…
          </p>
        )}
        {messagesQuery.isError && !messagesQuery.data && (
          <div role="alert" className="space-y-3 p-4 text-sm">
            <p>Unable to load messages.</p>
            <button
              type="button"
              className="text-primary underline"
              onClick={() => void messagesQuery.refetch()}
            >
              Retry
            </button>
          </div>
        )}
        {targetedMessageQuery.isLoading && (
          <p role="status" className="mx-4 mt-4 rounded-md border p-3 text-sm">
            Loading saved message…
          </p>
        )}
        {targetedMessageQuery.isError && (
          <p role="alert" className="mx-4 mt-4 rounded-md border p-3 text-sm">
            The saved message is unavailable or you do not have read access.
          </p>
        )}
        {targetedMessageQuery.isSuccess &&
          targetedMessageQuery.data === null && (
            <p
              role="status"
              className="mx-4 mt-4 rounded-md border p-3 text-sm"
            >
              The saved message is unavailable or was removed from this
              conversation.
            </p>
          )}
        {(messagesQuery.data || targetedMessageQuery.isSuccess) && (
          <>
            {selectedMessage?.body === "" && (
              <p
                role="status"
                className="mx-4 mt-4 rounded-md border p-3 text-sm"
              >
                The saved message was removed and its content is unavailable.
              </p>
            )}
            {messagesQuery.hasNextPage && (
              <div className="p-4 pb-0">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={messagesQuery.isFetchingNextPage}
                  onClick={() => void messagesQuery.fetchNextPage()}
                >
                  {messagesQuery.isFetchingNextPage
                    ? "Loading older messages…"
                    : "Load older messages"}
                </Button>
              </div>
            )}
            {messagesQuery.isFetchNextPageError && (
              <div role="alert" className="space-y-2 p-4 text-sm">
                <p>Unable to load older messages.</p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void messagesQuery.fetchNextPage()}
                >
                  Retry
                </Button>
              </div>
            )}
            <MessageTimeline
              messages={messages}
              {...(selectedMessageId ? { selectedMessageId } : {})}
            />
          </>
        )}
      </div>
      <div className="shrink-0 border-t bg-background/95">
        <MessageComposer
          identityId={identity.id}
          conversationId={conversation.id}
          canSend={canSend}
          {...(!canSend
            ? {
                unavailableReason:
                  authStatus === "unavailable" ||
                  authStatus === "unauthenticated"
                    ? "Sending is paused until you sign in again. Your draft remains here."
                    : authStatus === "context_changed"
                      ? "Sending is paused until you review the renewed identity."
                      : "Sending is unavailable until this connection is repaired.",
              }
            : {})}
        />
      </div>
    </section>
  );
}

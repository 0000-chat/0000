import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type {
  AccountGrant,
  AccountGrantOperationScope,
  AccountGrantTarget,
  ConnectedAccount,
  ConversationPageResult,
} from "@communicator/contracts";
import { ConnectionCard } from "./connection-card";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

const newIdempotencyKey = () => `ui-${crypto.randomUUID()}`;

const targetValue = (
  target: Pick<AccountGrantTarget, "membership_id" | "identity_id">,
) => `${target.membership_id}:${target.identity_id}`;

function ChatPicker({
  chats,
  selectedChatIds,
  onToggle,
  query,
}: {
  chats: readonly ConversationPageResult["items"][number][];
  selectedChatIds: readonly string[];
  onToggle: (chatId: string) => void;
  query: {
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
    hasNextPage: boolean | undefined;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
    isFetchNextPageError: boolean;
  };
}) {
  const selected = new Set(selectedChatIds);
  if (query.isLoading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading chats…
      </p>
    );
  if (query.isError) {
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>Unable to load chats for this account.</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {chats.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No chats are available for this account.
        </p>
      )}
      {chats.map((chat) => (
        <label
          key={chat.id}
          className="flex items-start gap-2 rounded-md border p-2 text-sm"
        >
          <input
            type="checkbox"
            checked={selected.has(chat.id)}
            onChange={() => onToggle(chat.id)}
            aria-label={`${chat.title} (${chat.id})`}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block font-medium">{chat.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {chat.id}
            </span>
          </span>
        </label>
      ))}
      {query.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading more chats…" : "Load more chats"}
        </Button>
      )}
      {query.isFetchNextPageError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load more chats.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void query.fetchNextPage()}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function GrantManagementPanel({
  accounts,
  grants,
  targets,
  accountsHasNextPage,
  accountsFetchingNextPage,
  onLoadMoreAccounts,
  grantsHasNextPage,
  grantsFetchingNextPage,
  onLoadMoreGrants,
  onChanged,
}: {
  accounts: readonly ConnectedAccount[];
  grants: readonly AccountGrant[];
  targets: readonly AccountGrantTarget[];
  accountsHasNextPage: boolean;
  accountsFetchingNextPage: boolean;
  onLoadMoreAccounts: () => void;
  grantsHasNextPage: boolean;
  grantsFetchingNextPage: boolean;
  onLoadMoreGrants: () => void;
  onChanged: () => void;
}) {
  const [targetKey, setTargetKey] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.account_id ?? "");
  const [operationScope, setOperationScope] =
    useState<AccountGrantOperationScope>("conversation.read");
  const [chatScope, setChatScope] = useState<"all_chats" | "selected_chats">(
    "all_chats",
  );
  const [chatIds, setChatIds] = useState<string[]>([]);
  const [narrowGrantId, setNarrowGrantId] = useState<string | null>(null);
  const [narrowChatIds, setNarrowChatIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectedTarget =
    targets.find((target) => targetValue(target) === targetKey) ?? targets[0];
  const narrowGrant = grants.find((grant) => grant.id === narrowGrantId);
  const pickerIdentityId =
    narrowGrant?.identity_id ?? selectedTarget?.identity_id;
  const pickerAccountId = narrowGrant?.account_id ?? accountId;
  const pickerSelectedChatIds =
    narrowGrantId === null ? chatIds : narrowChatIds;
  const chatLookupEnabled = Boolean(
    pickerIdentityId &&
      pickerAccountId &&
      (chatScope === "selected_chats" || narrowGrantId !== null),
  );
  const chatsQuery = useInfiniteQuery<ConversationPageResult, Error>({
    queryKey: queryKeys.grantChats(pickerIdentityId ?? "", pickerAccountId),
    queryFn: ({ pageParam }) =>
      apiClient.getAccountConversations(
        pickerAccountId,
        pickerIdentityId ?? "",
        typeof pageParam === "string" ? pageParam : undefined,
        2,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: chatLookupEnabled,
  });
  const chats = useMemo(
    () => chatsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [chatsQuery.data],
  );

  useEffect(() => {
    if (!targets.some((target) => targetValue(target) === targetKey)) {
      setTargetKey(selectedTarget ? targetValue(selectedTarget) : "");
    }
  }, [selectedTarget, targetKey, targets]);
  useEffect(() => {
    if (!accounts.some((account) => account.account_id === accountId)) {
      setAccountId(accounts[0]?.account_id ?? "");
    }
  }, [accountId, accounts]);
  useEffect(() => {
    if (narrowGrantId !== null && narrowGrant === undefined) {
      setNarrowGrantId(null);
      setNarrowChatIds([]);
    }
  }, [narrowGrant, narrowGrantId]);

  const createGrant = useMutation({
    mutationFn: () => {
      if (!selectedTarget || !accountId)
        throw new Error("Choose a target and account");
      if (chatScope === "selected_chats" && chatIds.length === 0) {
        throw new Error("Choose at least one chat");
      }
      return apiClient.createAccountGrant({
        membership_id: selectedTarget.membership_id,
        identity_id: selectedTarget.identity_id,
        account_id: accountId,
        operation_scope: operationScope,
        chat_scope: chatScope,
        chat_ids: chatScope === "selected_chats" ? chatIds : [],
        idempotency_key: newIdempotencyKey(),
      });
    },
    onSuccess: () => {
      setError(null);
      setChatIds([]);
      onChanged();
    },
    onError: (value) =>
      setError(
        value instanceof Error ? value.message : "Grant could not be saved",
      ),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) =>
      apiClient.revokeAccountGrant(grantId, newIdempotencyKey()),
    onSuccess: () => {
      setError(null);
      if (narrowGrantId !== null) setNarrowGrantId(null);
      onChanged();
    },
    onError: (value) =>
      setError(
        value instanceof Error ? value.message : "Grant could not be revoked",
      ),
  });

  const updateGrant = useMutation({
    mutationFn: ({ grant, ids }: { grant: AccountGrant; ids: string[] }) =>
      apiClient.updateAccountGrant(grant.id, {
        operation_scope: grant.operation_scope,
        chat_scope: "selected_chats",
        chat_ids: ids,
        idempotency_key: newIdempotencyKey(),
      }),
    onSuccess: () => {
      setError(null);
      setNarrowGrantId(null);
      setNarrowChatIds([]);
      onChanged();
    },
    onError: (value) =>
      setError(
        value instanceof Error ? value.message : "Grant could not be narrowed",
      ),
  });

  const toggleChat = (chatId: string) => {
    const setter = narrowGrantId === null ? setChatIds : setNarrowChatIds;
    setter((current) =>
      current.includes(chatId)
        ? current.filter((value) => value !== chatId)
        : [...current, chatId],
    );
  };

  return (
    <section
      aria-labelledby="grant-management-heading"
      className="rounded-xl border bg-card p-5 shadow-sm"
    >
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Administrator controls
        </p>
        <h2
          id="grant-management-heading"
          className="mt-1 text-xl font-semibold"
        >
          Account access grants
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Grant each eligible identity independent read, send, and webhook
          access for every account or selected chats.
        </p>
      </div>

      {targets.length === 0 && (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          No eligible grant targets are available.
        </p>
      )}
      <form
        className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          createGrant.mutate();
        }}
      >
        <label className="grid gap-1 text-sm font-medium">
          Identity
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={selectedTarget ? targetValue(selectedTarget) : ""}
            onChange={(event) => setTargetKey(event.target.value)}
            disabled={targets.length === 0}
          >
            {targets.map((target) => (
              <option key={targetValue(target)} value={targetValue(target)}>
                {target.identity_display_name} · {target.principal_display_name}{" "}
                ({target.principal_type})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Connected account
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={accounts.length === 0}
          >
            {accounts.map((account) => (
              <option key={account.account_id} value={account.account_id}>
                {account.display_label} account
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Permission
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={operationScope}
            onChange={(event) =>
              setOperationScope(
                event.target.value as AccountGrantOperationScope,
              )
            }
          >
            <option value="conversation.read">Read conversations</option>
            <option value="message.send">Send messages</option>
            <option value="webhook.manage">Manage webhooks</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Chat scope
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={chatScope}
            onChange={(event) =>
              setChatScope(event.target.value as "all_chats" | "selected_chats")
            }
          >
            <option value="all_chats">All current and future chats</option>
            <option value="selected_chats">Selected chats</option>
          </select>
        </label>
        <div className="flex items-end">
          <Button
            type="submit"
            className="w-full"
            disabled={!selectedTarget || !accountId || createGrant.isPending}
          >
            {createGrant.isPending ? "Saving…" : "Grant access"}
          </Button>
        </div>
      </form>

      {chatScope === "selected_chats" && (
        <div className="mt-3 grid gap-2 rounded-lg border p-3 sm:col-span-2">
          <p className="text-sm font-medium">
            Chats for selected identity and account
          </p>
          <ChatPicker
            chats={chats}
            selectedChatIds={pickerSelectedChatIds}
            onToggle={toggleChat}
            query={chatsQuery}
          />
          <p className="text-xs text-muted-foreground">
            {chatIds.length} chat{chatIds.length === 1 ? "" : "s"} selected.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-5 space-y-2">
        {grants.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No account grants have been created.
          </p>
        )}
        {grants.map((grant) => (
          <div
            key={grant.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
          >
            <div>
              <p className="font-medium">
                {grant.identity_display_name} · {grant.account_label}
              </p>
              <p className="text-muted-foreground">
                {grant.operation_scope} ·{" "}
                {grant.chat_scope === "all_chats"
                  ? "All chats"
                  : `${grant.chat_ids.length} selected chats`}{" "}
                · {grant.status}
              </p>
            </div>
            {grant.status === "active" && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={updateGrant.isPending}
                  onClick={() => {
                    setNarrowGrantId((current) =>
                      current === grant.id ? null : grant.id,
                    );
                    setNarrowChatIds(grant.chat_ids);
                  }}
                >
                  Narrow
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={revokeGrant.isPending}
                  onClick={() => revokeGrant.mutate(grant.id)}
                >
                  Revoke
                </Button>
              </div>
            )}
            {grant.status === "active" && narrowGrantId === grant.id && (
              <div className="basis-full space-y-2 rounded-lg border p-3">
                <p className="text-sm font-medium">
                  Select chats for narrowed access
                </p>
                <ChatPicker
                  chats={chats}
                  selectedChatIds={narrowChatIds}
                  onToggle={toggleChat}
                  query={chatsQuery}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={updateGrant.isPending || narrowChatIds.length === 0}
                  onClick={() =>
                    updateGrant.mutate({ grant, ids: narrowChatIds })
                  }
                >
                  {updateGrant.isPending ? "Saving…" : "Save narrowed access"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      {accountsHasNextPage && (
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          disabled={accountsFetchingNextPage}
          onClick={onLoadMoreAccounts}
        >
          {accountsFetchingNextPage
            ? "Loading more accounts…"
            : "Load more accounts"}
        </Button>
      )}
      {grantsHasNextPage && (
        <Button
          type="button"
          variant="outline"
          className="ml-2 mt-4"
          disabled={grantsFetchingNextPage}
          onClick={onLoadMoreGrants}
        >
          {grantsFetchingNextPage ? "Loading more grants…" : "Load more grants"}
        </Button>
      )}
    </section>
  );
}

export function ConnectionsPage() {
  const queryClient = useQueryClient();
  const {
    activeIdentity,
    session,
    isLoading: identitiesLoading,
  } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections(identityId),
    queryFn: () => apiClient.getConnections(identityId),
    enabled: Boolean(identityId),
  });
  const isAdministrator =
    (session?.membership.role === "owner" ||
      session?.membership.role === "admin") &&
    (session?.principal.type === "human" ||
      session?.principal.type === "operator");
  const accountsQuery = useInfiniteQuery({
    queryKey: queryKeys.connectedAccounts(identityId),
    queryFn: ({ pageParam }) =>
      apiClient.getConnectedAccounts(
        undefined,
        typeof pageParam === "string" ? pageParam : undefined,
        2,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: isAdministrator,
  });
  const grantsQuery = useInfiniteQuery({
    queryKey: queryKeys.accountGrants,
    queryFn: ({ pageParam }) =>
      apiClient.getAccountGrants(
        typeof pageParam === "string" ? pageParam : undefined,
        2,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: isAdministrator,
  });
  const targetsQuery = useInfiniteQuery({
    queryKey: queryKeys.grantTargets,
    queryFn: ({ pageParam }) =>
      apiClient.getGrantTargets(
        typeof pageParam === "string" ? pageParam : undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: isAdministrator,
  });
  const accounts =
    accountsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const grants = grantsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const targets = targetsQuery.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Identity-scoped connections
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Connections
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review provider connections for the selected identity and manage
          account-scoped access.
        </p>
      </div>

      {(identitiesLoading || connectionsQuery.isLoading) && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading connections…
        </p>
      )}
      {connectionsQuery.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load connections.</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void connectionsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {!identitiesLoading &&
        !connectionsQuery.isLoading &&
        !connectionsQuery.isError &&
        connectionsQuery.data?.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No connections are available for this identity.
          </p>
        )}
      <div className="grid gap-5 xl:grid-cols-2">
        {connectionsQuery.data?.map((connection) => {
          const targetIdentity = session?.identities.find(
            (identity) => identity.identity_id === connection.identity_id,
          );
          const canManageLinking = Boolean(
            isAdministrator &&
              activeIdentity?.kind === "human" &&
              activeIdentity.id === connection.identity_id &&
              targetIdentity?.kind === "human" &&
              targetIdentity.scopes.includes("connection.manage"),
          );
          return (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              canManageLinking={canManageLinking}
              actorDisplayName={
                session?.principal.display_name ?? "Administrator"
              }
              identityDisplayName={
                activeIdentity?.display_name ?? connection.display_label
              }
              onLinked={() => {
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.connections(identityId),
                });
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.connectedAccounts(identityId),
                });
              }}
            />
          );
        })}
      </div>
      {isAdministrator && (
        <>
          {(accountsQuery.isError ||
            grantsQuery.isError ||
            targetsQuery.isError) && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>Unable to load account grant management data.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void accountsQuery.refetch();
                  void grantsQuery.refetch();
                  void targetsQuery.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          )}
          {(accountsQuery.isLoading ||
            grantsQuery.isLoading ||
            targetsQuery.isLoading) && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading account grants…
            </p>
          )}
          <GrantManagementPanel
            accounts={accounts}
            grants={grants}
            targets={targets}
            accountsHasNextPage={accountsQuery.hasNextPage}
            accountsFetchingNextPage={accountsQuery.isFetchingNextPage}
            onLoadMoreAccounts={() => void accountsQuery.fetchNextPage()}
            grantsHasNextPage={grantsQuery.hasNextPage}
            grantsFetchingNextPage={grantsQuery.isFetchingNextPage}
            onLoadMoreGrants={() => void grantsQuery.fetchNextPage()}
            onChanged={() => {
              void queryClient.invalidateQueries({
                queryKey: queryKeys.accountGrants,
              });
            }}
          />
        </>
      )}
    </section>
  );
}

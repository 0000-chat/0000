import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AccountGrant, AccountGrantOperationScope, ConnectedAccount } from "@communicator/contracts";
import { ConnectionCard } from "./connection-card";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

const newIdempotencyKey = () => `ui-${crypto.randomUUID()}`;

function GrantManagementPanel({
  accounts,
  grants,
  identities,
  membershipId,
  onChanged,
}: {
  accounts: readonly ConnectedAccount[];
  grants: readonly AccountGrant[];
  identities: readonly { id: string; display_name: string }[];
  membershipId: string;
  onChanged: () => void;
}) {
  const [identityId, setIdentityId] = useState(identities[0]?.id ?? "");
  const [accountId, setAccountId] = useState(accounts[0]?.account_id ?? "");
  const [operationScope, setOperationScope] = useState<AccountGrantOperationScope>("conversation.read");
  const [chatScope, setChatScope] = useState<"all_chats" | "selected_chats">("all_chats");
  const [chatIds, setChatIds] = useState("");
  const [narrowGrantId, setNarrowGrantId] = useState<string | null>(null);
  const [narrowChatIds, setNarrowChatIds] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!identities.some((identity) => identity.id === identityId)) {
      setIdentityId(identities[0]?.id ?? "");
    }
  }, [identities, identityId]);
  useEffect(() => {
    if (!accounts.some((account) => account.account_id === accountId)) {
      setAccountId(accounts[0]?.account_id ?? "");
    }
  }, [accounts, accountId]);

  const createGrant = useMutation({
    mutationFn: () => apiClient.createAccountGrant({
      membership_id: membershipId,
      identity_id: identityId,
      account_id: accountId,
      operation_scope: operationScope,
      chat_scope: chatScope,
      chat_ids: chatScope === "selected_chats"
        ? chatIds.split(",").map((value) => value.trim()).filter(Boolean)
        : [],
      idempotency_key: newIdempotencyKey(),
    }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (value) => setError(value instanceof Error ? value.message : "Grant could not be saved"),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) => apiClient.revokeAccountGrant(grantId, newIdempotencyKey()),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (value) => setError(value instanceof Error ? value.message : "Grant could not be revoked"),
  });

  const updateGrant = useMutation({
    mutationFn: ({ grant, ids }: { grant: AccountGrant; ids: string[] }) => apiClient.updateAccountGrant(grant.id, {
      operation_scope: grant.operation_scope,
      chat_scope: "selected_chats",
      chat_ids: ids,
      idempotency_key: newIdempotencyKey(),
    }),
    onSuccess: () => {
      setError(null);
      setNarrowGrantId(null);
      setNarrowChatIds("");
      onChanged();
    },
    onError: (value) => setError(value instanceof Error ? value.message : "Grant could not be narrowed"),
  });

  return (
    <section aria-labelledby="grant-management-heading" className="rounded-xl border bg-card p-5 shadow-sm">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Administrator controls</p>
        <h2 id="grant-management-heading" className="mt-1 text-xl font-semibold">Account access grants</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Grant each identity independent read, send, and webhook access for every account or selected chats.
        </p>
      </div>

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
          <select className="h-9 rounded-md border bg-background px-2" value={identityId} onChange={(event) => setIdentityId(event.target.value)}>
            {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.display_name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Connected account
          <select className="h-9 rounded-md border bg-background px-2" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.account_id} value={account.account_id}>{account.display_label} account</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Permission
          <select className="h-9 rounded-md border bg-background px-2" value={operationScope} onChange={(event) => setOperationScope(event.target.value as AccountGrantOperationScope)}>
            <option value="conversation.read">Read conversations</option>
            <option value="message.send">Send messages</option>
            <option value="webhook.manage">Manage webhooks</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Chat scope
          <select className="h-9 rounded-md border bg-background px-2" value={chatScope} onChange={(event) => setChatScope(event.target.value as "all_chats" | "selected_chats")}>
            <option value="all_chats">All current and future chats</option>
            <option value="selected_chats">Selected chats</option>
          </select>
        </label>
        <div className="flex items-end">
          <Button type="submit" className="w-full" disabled={!membershipId || !identityId || !accountId || createGrant.isPending}>
            {createGrant.isPending ? "Saving…" : "Grant access"}
          </Button>
        </div>
        {chatScope === "selected_chats" && (
          <label className="grid gap-1 text-sm font-medium sm:col-span-2 lg:col-span-4">
            Chat IDs
            <input className="h-9 rounded-md border bg-background px-2" value={chatIds} onChange={(event) => setChatIds(event.target.value)} placeholder="chat_123, chat_456" required />
          </label>
        )}
      </form>

      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 space-y-2">
        {grants.length === 0 && <p className="text-sm text-muted-foreground">No account grants have been created.</p>}
        {grants.map((grant) => (
          <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
            <div>
              <p className="font-medium">{grant.identity_display_name} · {grant.account_label}</p>
              <p className="text-muted-foreground">{grant.operation_scope} · {grant.chat_scope === "all_chats" ? "All chats" : `${grant.chat_ids.length} selected chats`} · {grant.status}</p>
            </div>
            {grant.status === "active" && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={updateGrant.isPending}
                  onClick={() => {
                    setNarrowGrantId((current) => current === grant.id ? null : grant.id);
                    setNarrowChatIds(grant.chat_ids.join(", "));
                  }}
                >
                  Narrow
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={revokeGrant.isPending} onClick={() => revokeGrant.mutate(grant.id)}>
                  Revoke
                </Button>
              </div>
            )}
            {grant.status === "active" && narrowGrantId === grant.id && (
              <form
                className="basis-full grid gap-2 sm:grid-cols-[1fr_auto]"
                onSubmit={(event) => {
                  event.preventDefault();
                  const ids = narrowChatIds.split(",").map((value) => value.trim()).filter(Boolean);
                  if (ids.length === 0) {
                    setError("Enter at least one chat ID to narrow access");
                    return;
                  }
                  updateGrant.mutate({ grant, ids });
                }}
              >
                <label className="grid gap-1 text-sm font-medium">
                  Selected chat IDs
                  <input
                    className="h-9 rounded-md border bg-background px-2"
                    value={narrowChatIds}
                    onChange={(event) => setNarrowChatIds(event.target.value)}
                    placeholder="chat_123, chat_456"
                    aria-label={`Selected chat IDs for ${grant.identity_display_name}`}
                    required
                  />
                </label>
                <Button type="submit" size="sm" className="self-end" disabled={updateGrant.isPending}>
                  {updateGrant.isPending ? "Saving…" : "Save narrowed access"}
                </Button>
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ConnectionsPage() {
  const queryClient = useQueryClient();
  const { activeIdentity, identities, session, isLoading: identitiesLoading } = useIdentityContext();
  const identityId = activeIdentity?.id ?? "";
  const { data: connections = [], isLoading } = useQuery({
    queryKey: queryKeys.connections(identityId),
    queryFn: () => apiClient.getConnections(identityId),
    enabled: Boolean(identityId),
  });
  const isAdministrator = (session?.membership.role === "owner" || session?.membership.role === "admin")
    && (session?.principal.type === "human" || session?.principal.type === "operator");
  const { data: accountPage, isLoading: accountsLoading } = useQuery({
    queryKey: queryKeys.connectedAccounts(identityId),
    queryFn: () => apiClient.getConnectedAccounts(identityId),
    enabled: isAdministrator && Boolean(identityId),
  });
  const { data: grantPage, isLoading: grantsLoading } = useQuery({
    queryKey: queryKeys.accountGrants,
    queryFn: () => apiClient.getAccountGrants(),
    enabled: isAdministrator,
  });

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Identity-scoped connections</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review provider connections for the selected identity and manage account-scoped access.
        </p>
      </div>

      {(identitiesLoading || isLoading) && (
        <p role="status" className="text-sm text-muted-foreground">Loading connections…</p>
      )}
      {!identitiesLoading && !isLoading && connections.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No connections are available for this identity.
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {connections.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} />
        ))}
      </div>
      {isAdministrator && (
        <GrantManagementPanel
          accounts={accountPage?.items ?? []}
          grants={grantPage?.items ?? []}
          identities={identities}
          membershipId={session?.membership.id ?? ""}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.accountGrants });
          }}
        />
      )}
      {isAdministrator && (accountsLoading || grantsLoading) && (
        <p role="status" className="text-sm text-muted-foreground">Loading account grants…</p>
      )}
    </section>
  );
}

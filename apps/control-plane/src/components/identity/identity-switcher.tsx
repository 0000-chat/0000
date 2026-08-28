import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRouter } from "@tanstack/react-router";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { Identity } from "@communicator/contracts";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

type IdentityContextValue = {
  identities: Identity[];
  activeIdentity: Identity | undefined;
  isLoading: boolean;
  switchIdentity: (identityId: string) => Promise<void>;
};

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { search } = useLocation();
  const { data: identities = [], isLoading } = useQuery({
    queryKey: queryKeys.identities,
    queryFn: () => apiClient.getIdentities(),
  });
  const activeIdentity = identities.find((item) => item.id === search.identity) ?? identities[0];

  useEffect(() => {
    if (activeIdentity && search.identity !== activeIdentity.id) {
      void router.navigate({
        to: router.state.location.pathname as "/",
        search: { identity: activeIdentity.id },
        replace: true,
      });
    }
  }, [activeIdentity, router, search.identity]);

  const switchIdentity = async (identityId: string): Promise<void> => {
    if (!identities.some((item) => item.id === identityId)) return;

    const pathname = router.state.location.pathname;
    const inConversationThread = pathname.startsWith("/conversations/");
    await queryClient.cancelQueries({
      predicate: (query) => ["channels", "conversations", "conversation", "messages", "commands"]
        .includes(String(query.queryKey[0])),
    });

    await router.navigate({
      to: inConversationThread ? "/conversations" : pathname as "/",
      search: { identity: identityId },
    });
  };

  return (
    <IdentityContext.Provider value={{ identities, activeIdentity, isLoading, switchIdentity }}>
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentityContext() {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("useIdentityContext must be used within IdentityProvider");
  return value;
}

export function IdentitySwitcher() {
  const { identities, activeIdentity, switchIdentity } = useIdentityContext();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="active-identity" className="text-sm font-medium">
        Active identity
      </label>
      <select
        id="active-identity"
        value={activeIdentity?.id ?? ""}
        onChange={(event) => void switchIdentity(event.target.value)}
        disabled={identities.length === 0}
        className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {identities.map((identity) => (
          <option key={identity.id} value={identity.id}>{identity.display_name}</option>
        ))}
      </select>
    </div>
  );
}

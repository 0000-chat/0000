import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRouter } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Identity, SessionResponse } from "@communicator/contracts";
import { ApiError, apiClient, identitiesFromSession } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";
import { Button } from "@/components/ui/button";

type AuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "unavailable"
  | "context_changed";

type IdentityContextValue = {
  session: SessionResponse | undefined;
  identities: Identity[];
  activeIdentity: Identity | undefined;
  isLoading: boolean;
  authStatus: AuthStatus;
  authError: string | undefined;
  contextChanged: boolean;
  login: () => void;
  retrySession: () => Promise<void>;
  logout: () => Promise<void>;
  acceptContextChange: () => void;
  switchIdentity: (identityId: string) => Promise<void>;
};

function sessionContextKey(
  session: SessionResponse,
  requestedIdentityId: string | undefined,
) {
  const selectedIdentityId =
    requestedIdentityId ?? session.identities[0]?.identity_id;
  const selectedIdentity = session.identities.find(
    (identity) => identity.identity_id === selectedIdentityId,
  );
  return JSON.stringify({
    binding_id: session.binding_id ?? null,
    tenant: session.tenant.id,
    principal: session.principal.id,
    membership: session.membership.id,
    selected_identity_id: selectedIdentityId ?? null,
    selected_identity: selectedIdentity
      ? {
          kind: selectedIdentity.kind,
          display_name: selectedIdentity.display_name,
          scopes: [...selectedIdentity.scopes].sort(),
        }
      : null,
  });
}

const IdentityContext = createContext<IdentityContextValue | null>(null);
const identityScopedQueryRoots = new Set([
  "connections",
  "channels",
  "conversations",
  "conversation",
  "messages",
  "commands",
]);

export function IdentityProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { search } = useLocation();
  const [loggedOut, setLoggedOut] = useState(false);
  const [contextPaused, setContextPaused] = useState(false);
  const [selectionOverride, setSelectionOverride] = useState<string>();
  const [requestAuthFailure, setRequestAuthFailure] = useState<ApiError>();
  const [logoutError, setLogoutError] = useState<string>();
  const acceptedContext = useRef<string | undefined>(undefined);
  const stableSession = useRef<SessionResponse | undefined>(undefined);
  const stableSelectedIdentityId = useRef<string | undefined>(undefined);
  const sessionQuery = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiClient.getSession(),
    enabled: !loggedOut,
    refetchOnWindowFocus: true,
  });
  const {
    data: session,
    dataUpdatedAt: sessionUpdatedAt,
    error,
    isLoading,
    isSuccess: sessionReadSucceeded,
  } = sessionQuery;
  useEffect(() => {
    const unsubscribe = apiClient.subscribeAuthFailures(
      ({ error: authError }) => {
        setRequestAuthFailure(authError);
      },
    );
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (sessionReadSucceeded && session && !error) {
      setRequestAuthFailure(undefined);
    }
  }, [error, session, sessionReadSucceeded, sessionUpdatedAt]);
  const requestedIdentityId = selectionOverride ?? search.identity;
  const sessionContext =
    session?.binding_id === undefined
      ? undefined
      : sessionContextKey(session, requestedIdentityId);
  const contextMismatch =
    acceptedContext.current !== undefined &&
    sessionContext !== undefined &&
    acceptedContext.current !== sessionContext;
  const contextChanged = contextPaused || contextMismatch;

  useEffect(() => {
    if (sessionContext === undefined || loggedOut || !session) return;
    if (acceptedContext.current === undefined) {
      acceptedContext.current = sessionContext;
      stableSession.current = session;
      stableSelectedIdentityId.current =
        requestedIdentityId ?? session.identities[0]?.identity_id;
      return;
    }
    if (acceptedContext.current !== sessionContext) setContextPaused(true);
  }, [loggedOut, requestedIdentityId, session, sessionContext]);

  useEffect(() => {
    if (
      session &&
      !contextChanged &&
      sessionContext !== undefined &&
      acceptedContext.current === sessionContext
    ) {
      stableSession.current = session;
      stableSelectedIdentityId.current =
        requestedIdentityId ?? session.identities[0]?.identity_id;
    }
  }, [contextChanged, requestedIdentityId, session, sessionContext]);

  useEffect(() => {
    if (
      selectionOverride !== undefined &&
      search.identity === selectionOverride
    ) {
      setSelectionOverride(undefined);
    }
  }, [search.identity, selectionOverride]);

  useEffect(() => {
    if (loggedOut) return;
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loggedOut, queryClient]);

  const workspaceSession = contextChanged ? stableSession.current : session;
  const identities = useMemo(
    () => (workspaceSession ? identitiesFromSession(workspaceSession) : []),
    [workspaceSession],
  );
  const activeIdentityId = contextChanged
    ? stableSelectedIdentityId.current
    : requestedIdentityId;
  const activeIdentity =
    activeIdentityId !== undefined
      ? identities.find((item) => item.id === activeIdentityId)
      : contextChanged
        ? undefined
        : identities[0];

  useEffect(() => {
    if (contextChanged) return;
    if (activeIdentity && search.identity === undefined) {
      void router.navigate({
        to: router.state.location.pathname as "/",
        search: { identity: activeIdentity.id },
        replace: true,
      });
    }
  }, [activeIdentity, contextChanged, router, search.identity]);

  const switchIdentity = async (identityId: string): Promise<void> => {
    if (contextChanged) return;
    if (!identities.some((item) => item.id === identityId)) return;

    setSelectionOverride(identityId);
    if (session?.binding_id !== undefined) {
      acceptedContext.current = sessionContextKey(session, identityId);
      stableSession.current = session;
      stableSelectedIdentityId.current = identityId;
      setContextPaused(false);
    }

    const previousIdentityId = activeIdentity?.id;
    const pathname = router.state.location.pathname;
    const inConversationThread = pathname.startsWith("/conversations/");
    const isPreviousIdentityQuery = (query: {
      queryKey: readonly unknown[];
    }) => {
      const root = query.queryKey[0];
      return (
        previousIdentityId !== undefined &&
        previousIdentityId !== identityId &&
        query.queryKey[1] === previousIdentityId &&
        typeof root === "string" &&
        identityScopedQueryRoots.has(root)
      );
    };
    await queryClient.cancelQueries({ predicate: isPreviousIdentityQuery });
    queryClient.removeQueries({ predicate: isPreviousIdentityQuery });

    await router.navigate({
      to: inConversationThread ? "/conversations" : (pathname as "/"),
      search: { identity: identityId },
    });
  };

  const login = () => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.open(
      `/auth/login?return_to=${encodeURIComponent(returnTo)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const retrySession = async () => {
    setLoggedOut(false);
    setLogoutError(undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.session });
  };

  const logout = async () => {
    let logoutConfirmed = false;
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { Origin: window.location.origin },
      });
      logoutConfirmed = response.ok;
      if (!logoutConfirmed) {
        const status = response.status === 503 ? "unavailable" : "failed";
        throw new Error(`Logout ${status}`);
      }
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "Logout unavailable",
      );
    } finally {
      if (logoutConfirmed) {
        setLogoutError(undefined);
        setLoggedOut(true);
        setContextPaused(false);
        acceptedContext.current = undefined;
        stableSelectedIdentityId.current = undefined;
        await queryClient.cancelQueries();
        queryClient.clear();
        await router.navigate({ to: "/", replace: true });
      }
    }
  };

  const acceptContextChange = () => {
    if (sessionContext === undefined) return;
    acceptedContext.current = sessionContext;
    stableSession.current = session;
    stableSelectedIdentityId.current = session?.identities.some(
      (identity) => identity.identity_id === search.identity,
    )
      ? search.identity
      : search.identity === undefined
        ? session?.identities[0]?.identity_id
        : undefined;
    setContextPaused(false);
    void queryClient.invalidateQueries();
  };

  const authStatus: AuthStatus = isLoading
    ? "loading"
    : contextChanged
      ? "context_changed"
      : logoutError || requestAuthFailure
        ? requestAuthFailure?.status === 401
          ? "unauthenticated"
          : "unavailable"
        : error instanceof ApiError && error.status === 503
          ? "unavailable"
          : error instanceof ApiError && error.status === 401
            ? "unauthenticated"
            : session
              ? "authenticated"
              : "unauthenticated";
  const authError =
    logoutError ??
    requestAuthFailure?.message ??
    (error instanceof Error
      ? error.message
      : error
        ? "Authentication failed"
        : undefined);

  return (
    <IdentityContext.Provider
      value={{
        session: workspaceSession,
        identities,
        activeIdentity,
        isLoading,
        authStatus,
        authError,
        contextChanged,
        login,
        retrySession,
        logout,
        acceptContextChange,
        switchIdentity,
      }}
    >
      {children}
    </IdentityContext.Provider>
  );
}

export function useIdentityContext() {
  const value = useContext(IdentityContext);
  if (!value)
    throw new Error("useIdentityContext must be used within IdentityProvider");
  return value;
}

export function IdentitySwitcher() {
  const {
    identities,
    activeIdentity,
    switchIdentity,
    contextChanged,
    authStatus,
    logout,
  } = useIdentityContext();

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <label
        htmlFor="active-identity"
        className="sr-only text-sm font-medium sm:not-sr-only"
      >
        Active identity
      </label>
      <select
        id="active-identity"
        value={activeIdentity?.id ?? ""}
        onChange={(event) => void switchIdentity(event.target.value)}
        disabled={identities.length === 0 || contextChanged}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:px-3"
      >
        {identities.map((identity) => (
          <option key={identity.id} value={identity.id}>
            {identity.display_name}
          </option>
        ))}
      </select>
      {authStatus === "authenticated" || authStatus === "context_changed" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void logout()}
        >
          Log out
        </Button>
      ) : null}
    </div>
  );
}

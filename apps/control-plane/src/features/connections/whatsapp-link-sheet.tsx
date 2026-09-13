import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LinkSession, LinkSessionStatus } from "@communicator/contracts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { apiClient, ApiError } from "@/lib/api/client";

type LinkViewState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "active";
      session: LinkSession;
      qr: string | null;
      message: string | null;
    }
  | { kind: "terminal"; session: LinkSession }
  | { kind: "failed"; session: LinkSession | null; message: string };

type LinkViewProps = {
  identityId: string;
  identityDisplayName: string;
  actorDisplayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
};

const pendingStatuses = new Set<LinkSessionStatus>([
  "created",
  "awaiting_user",
  "authenticating",
]);

const terminalStatuses = new Set<LinkSessionStatus>([
  "connected",
  "expired",
  "failed",
  "cancelled",
  "relink_required",
  "reconciliation_required",
]);

const newIdempotencyKey = () => `ui-link-${crypto.randomUUID()}`;

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function statusLabel(status: LinkSessionStatus) {
  if (status === "awaiting_user") return "Waiting for QR scan";
  if (status === "relink_required") return "Relinking required";
  return titleCase(status);
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return "The provider rejected this linking attempt. Start a new attempt and try again.";
  }
  if (error instanceof ApiError && error.status >= 500) {
    return "The private WhatsApp linking service is unavailable. Try again shortly.";
  }
  return "The linking attempt could not be completed. Start a new attempt and try again.";
}

function isDirectImage(payload: string) {
  return (
    payload.startsWith("data:image/") || payload.trimStart().startsWith("<svg")
  );
}

function imageSource(payload: string) {
  return payload.startsWith("data:image/")
    ? payload
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload)}`;
}

function QrImage({ payload }: { payload: string }) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setSource(null);
    if (isDirectImage(payload)) {
      setSource(imageSource(payload));
      return () => {
        disposed = true;
      };
    }
    void QRCode.toString(payload, { type: "svg", margin: 2, width: 280 })
      .then((svg) => {
        if (!disposed) setSource(imageSource(svg));
      })
      .catch(() => {
        if (!disposed) setSource(null);
      });
    return () => {
      disposed = true;
      setSource(null);
    };
  }, [payload]);

  if (!source) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Preparing the secure QR code…
      </p>
    );
  }
  return (
    <img
      src={source}
      alt="WhatsApp QR code to scan from Linked devices"
      className="mx-auto aspect-square w-full max-w-[280px] rounded-lg border bg-white p-3"
    />
  );
}

function secondsRemaining(expiresAt: string, now: number) {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

function challengeExpiresAt(session: LinkSession) {
  const productExpiry = Date.parse(session.expires_at);
  const actionExpiry = session.action_expires_at
    ? Date.parse(session.action_expires_at)
    : productExpiry;
  return new Date(Math.min(productExpiry, actionExpiry)).toISOString();
}

function applySession(
  session: LinkSession,
  previousQr: string | null,
): LinkViewState {
  if (terminalStatuses.has(session.status)) {
    return { kind: "terminal", session: { ...session, qr: null } };
  }
  return {
    kind: "active",
    session,
    qr:
      Date.parse(challengeExpiresAt(session)) <= Date.now()
        ? null
        : (session.qr ?? previousQr),
    message: null,
  };
}

function sessionIdForState(state: LinkViewState) {
  if (state.kind === "active" || state.kind === "terminal") {
    return state.session.id;
  }
  if (state.kind === "failed") return state.session?.id ?? null;
  return null;
}

export function WhatsAppLinkSheet({
  identityId,
  identityDisplayName,
  actorDisplayName,
  open,
  onOpenChange,
  onLinked,
}: LinkViewProps) {
  const [state, setState] = useState<LinkViewState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const openRef = useRef(open);
  const generationRef = useRef(0);
  const cancelledSessionsRef = useRef(new Set<string>());
  const linkedSessionRef = useRef<string | null>(null);

  stateRef.current = state;
  openRef.current = open;

  const isCurrent = useCallback((generation: number) => {
    return (
      mountedRef.current &&
      openRef.current &&
      generationRef.current === generation
    );
  }, []);

  const cancelSession = useCallback(async (sessionId: string) => {
    if (cancelledSessionsRef.current.has(sessionId)) return;
    cancelledSessionsRef.current.add(sessionId);
    try {
      await apiClient.cancelLinkSession(sessionId, newIdempotencyKey());
    } catch {
      // The local state is already cleared. The server alarm remains the cleanup backstop.
    }
  }, []);

  const startSession = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    linkedSessionRef.current = null;
    setState({ kind: "starting" });
    try {
      const session = await apiClient.startLinkSession(
        identityId,
        {
          provider: "whatsapp",
          method: "qr",
          confirmed_identity_id: identityId,
        },
        newIdempotencyKey(),
      );
      if (!isCurrent(generation)) {
        await cancelSession(session.id);
        return;
      }
      setState(applySession(session, null));
    } catch (error) {
      if (isCurrent(generation)) {
        setState({
          kind: "failed",
          session: null,
          message: errorMessage(error),
        });
      }
    }
  }, [cancelSession, identityId, isCurrent]);

  const cancelCurrent = useCallback(() => {
    generationRef.current += 1;
    const current = stateRef.current;
    setState({ kind: "idle" });
    const sessionId = sessionIdForState(current);
    if (sessionId) void cancelSession(sessionId);
  }, [cancelSession]);

  const runAction = useCallback(
    async (action: "poll" | "refresh") => {
      const current = stateRef.current;
      if (current.kind !== "active") return;
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      const previousQr = action === "refresh" ? null : current.qr;
      if (action === "refresh") {
        setState({ ...current, qr: null, message: null });
      }
      try {
        const session = await apiClient.actLinkSession(
          current.session.id,
          { generation: current.session.generation, action },
          newIdempotencyKey(),
        );
        if (!isCurrent(generation)) return;
        setState(applySession(session, previousQr));
      } catch (error) {
        if (isCurrent(generation)) {
          void cancelSession(current.session.id);
          setState({
            kind: "failed",
            session: { ...current.session, qr: null },
            message: errorMessage(error),
          });
        }
      }
    },
    [cancelSession, isCurrent],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const current = stateRef.current;
      const sessionId = sessionIdForState(current);
      if (sessionId) void cancelSession(sessionId);
    };
  }, [cancelSession]);

  useEffect(() => {
    if (open && state.kind === "idle") void startSession();
  }, [open, startSession, state.kind]);

  useEffect(() => {
    if (
      !open ||
      state.kind !== "active" ||
      !pendingStatuses.has(state.session.status)
    )
      return;
    const timer = window.setTimeout(() => {
      if (Date.parse(challengeExpiresAt(state.session)) <= Date.now()) {
        generationRef.current += 1;
        const expired: LinkSession = {
          ...state.session,
          status: "expired",
          action: "none",
          action_expires_at: null,
          qr: null,
          error_code: "expired",
        };
        setState({ kind: "terminal", session: expired });
        void cancelSession(state.session.id);
        return;
      }
      void runAction("poll");
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [cancelSession, open, runAction, state]);

  useEffect(() => {
    if (!open || state.kind !== "active") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, state.kind]);

  useEffect(() => {
    if (
      state.kind === "terminal" &&
      state.session.status === "connected" &&
      linkedSessionRef.current !== state.session.id
    ) {
      linkedSessionRef.current = state.session.id;
      onLinked();
    }
  }, [onLinked, state]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) cancelCurrent();
    else setNow(Date.now());
    onOpenChange(nextOpen);
  };

  const retry = () => {
    const sessionId = sessionIdForState(stateRef.current);
    if (sessionId) void cancelSession(sessionId);
    setNow(Date.now());
    void startSession();
  };

  const active = state.kind === "active" ? state : null;
  const terminal = state.kind === "terminal" ? state : null;
  const failed = state.kind === "failed" ? state : null;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Link WhatsApp account</SheetTitle>
          <SheetDescription>
            Scan the QR code from WhatsApp Linked devices. The challenge stays
            in this administrator session and is cleared when the attempt ends.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4">
          <dl className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="font-medium">WhatsApp</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Administrator</dt>
              <dd className="font-medium">{actorDisplayName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Target identity</dt>
              <dd className="font-medium">{identityDisplayName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Identity ID</dt>
              <dd className="truncate font-mono text-xs">{identityId}</dd>
            </div>
          </dl>

          {state.kind === "starting" && (
            <p role="status" className="text-sm text-muted-foreground">
              Starting a private WhatsApp linking session…
            </p>
          )}

          {active && (
            <section aria-label="WhatsApp link status" className="space-y-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {statusLabel(active.session.status)}
                </span>
                <span className="text-muted-foreground">
                  Expires in{" "}
                  {secondsRemaining(challengeExpiresAt(active.session), now)}s
                </span>
              </div>
              {active.qr ? (
                <QrImage payload={active.qr} />
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  Waiting for the private provider response…
                </p>
              )}
              {active.message && (
                <p role="alert" className="text-sm text-destructive">
                  {active.message}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void runAction("refresh")}
                >
                  Refresh QR
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
              </div>
            </section>
          )}

          {terminal && terminal.session.status === "connected" && (
            <section role="status" className="space-y-3">
              <p className="text-lg font-semibold">WhatsApp account linked</p>
              <p className="text-sm text-muted-foreground">
                {terminal.session.provider_label ?? "The provider account"} is
                ready for this human identity. No agent access was granted.
              </p>
            </section>
          )}

          {terminal && terminal.session.status === "relink_required" && (
            <section role="alert" className="space-y-3">
              <p className="text-lg font-semibold">Relinking required</p>
              <p className="text-sm text-muted-foreground">
                This WhatsApp account is already linked. Relinking and
                disconnecting are handled separately by the account lifecycle.
              </p>
            </section>
          )}

          {terminal && terminal.session.status === "expired" && (
            <section role="alert" className="space-y-3">
              <p className="text-lg font-semibold">QR session expired</p>
              <p className="text-sm text-muted-foreground">
                The challenge was cleared. Start a new attempt to continue.
              </p>
              <Button type="button" onClick={retry}>
                Try again
              </Button>
            </section>
          )}

          {terminal && terminal.session.status === "failed" && (
            <section role="alert" className="space-y-3">
              <p className="text-lg font-semibold">WhatsApp linking failed</p>
              <p className="text-sm text-muted-foreground">
                The private provider could not complete the linking attempt.
              </p>
              <Button type="button" onClick={retry}>
                Try again
              </Button>
            </section>
          )}

          {terminal &&
            terminal.session.status === "reconciliation_required" && (
              <section role="alert" className="space-y-3">
                <p className="text-lg font-semibold">Link needs attention</p>
                <p className="text-sm text-muted-foreground">
                  The provider result was received, but the account directory
                  needs administrator reconciliation before another attempt.
                </p>
              </section>
            )}

          {terminal && terminal.session.status === "cancelled" && (
            <section role="status" className="space-y-3">
              <p className="text-lg font-semibold">Linking cancelled</p>
              <p className="text-sm text-muted-foreground">
                The QR challenge and provider attempt were cleared.
              </p>
            </section>
          )}

          {failed && (
            <section role="alert" className="space-y-3">
              <p className="text-lg font-semibold">WhatsApp linking failed</p>
              <p className="text-sm text-muted-foreground">{failed.message}</p>
              <Button type="button" onClick={retry}>
                Try again
              </Button>
            </section>
          )}
        </div>

        {(terminal || failed) && (
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              aria-label="Close linking dialog"
              onClick={() => handleOpenChange(false)}
            >
              Close
            </Button>
            {terminal?.session.status === "connected" && (
              <Button type="button" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ConnectedAccount,
  HistoryImport,
  HistoryImportDetail,
  HistoryImportRange,
  ProviderCapability,
  SessionResponse,
} from "@communicator/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/query-keys";

const newIdempotencyKey = () => `ui-history-${crypto.randomUUID()}`;

const titleCase = (value: string) =>
  value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const formatTimestamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-NZ", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown";

const formatRange = (range: Pick<HistoryImportRange, "start_at" | "end_at">) =>
  `${formatTimestamp(range.start_at)} – ${formatTimestamp(range.end_at)}`;

const badgeVariant = (status: string) => {
  if (status === "failed" || status === "unsupported")
    return "destructive" as const;
  if (
    status === "partial" ||
    status === "conditional" ||
    status === "unverified"
  )
    return "outline" as const;
  return "secondary" as const;
};

const toIsoTimestamp = (value: string, label: string) => {
  if (!value) throw new Error(`${label} is required`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date.toISOString();
};

const progressPercent = (item: HistoryImport) =>
  item.total_range_count > 0
    ? Math.min(100, (item.completed_range_count / item.total_range_count) * 100)
    : 0;

const isAdministrator = (session: SessionResponse | undefined) =>
  Boolean(
    session &&
      (session.membership.role === "owner" ||
        session.membership.role === "admin") &&
      (session.principal.type === "human" ||
        session.principal.type === "operator"),
  );

const canManageAccount = (
  account: ConnectedAccount,
  session: SessionResponse | undefined,
) =>
  isAdministrator(session) &&
  Boolean(
    session?.identities.some(
      (identity) =>
        identity.identity_id === account.identity_id &&
        identity.scopes.includes("connection.manage"),
    ),
  );

function CapabilityProof({
  capabilities,
}: {
  capabilities: readonly ProviderCapability[];
}) {
  if (capabilities.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No capability evidence is recorded.
      </p>
    );
  return (
    <div className="space-y-2">
      {capabilities.map((capability) => (
        <div
          key={capability.capability}
          className="rounded-md border p-2 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{capability.capability}</span>
            <span className="flex items-center gap-1.5">
              <Badge variant={badgeVariant(capability.status)}>
                {titleCase(capability.status)}
              </Badge>
              <Badge variant="outline">{titleCase(capability.freshness)}</Badge>
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {capability.product_claim}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Proof: {capability.proof_source}
            {capability.provider_version
              ? ` · Provider ${capability.provider_version}`
              : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Observed {formatTimestamp(capability.observed_at)}
          </p>
        </div>
      ))}
    </div>
  );
}

function RangeRow({
  range,
  canManage,
  canAdvance,
  isAdvancing,
  onAdvance,
}: {
  range: HistoryImportRange;
  canManage: boolean;
  canAdvance: boolean;
  isAdvancing: boolean;
  onAdvance: () => void;
}) {
  return (
    <li className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={badgeVariant(range.status)}>
            {titleCase(range.status)}
          </Badge>
          <span className="font-medium">{formatRange(range)}</span>
        </div>
        {canManage && canAdvance && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isAdvancing}
            onClick={onAdvance}
          >
            {isAdvancing ? "Advancing…" : "Advance range"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {range.event_count} event{range.event_count === 1 ? "" : "s"} ·{" "}
        {range.attempt_count} attempt{range.attempt_count === 1 ? "" : "s"}
      </p>
      {range.gap_code && (
        <p className="mt-1 text-xs text-amber-800">
          Known gap: {range.gap_code}
        </p>
      )}
      {range.error_code && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Failure: {titleCase(range.error_code)}
        </p>
      )}
    </li>
  );
}

function HistoryImportAccountCard({
  account,
  session,
}: {
  account: ConnectedAccount;
  session: SessionResponse | undefined;
}) {
  const queryClient = useQueryClient();
  const canManage = canManageAccount(account, session);
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null);
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [maxEvents, setMaxEvents] = useState("500");

  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.historyCapabilities(
      account.account_id,
      account.identity_id,
    ),
    queryFn: () =>
      apiClient.getProviderCapabilities(
        account.account_id,
        account.identity_id,
      ),
  });
  const importsQuery = useInfiniteQuery({
    queryKey: queryKeys.historyImports(account.account_id, account.identity_id),
    queryFn: ({ pageParam }) =>
      apiClient.getHistoryImports(
        account.account_id,
        account.identity_id,
        typeof pageParam === "string" ? pageParam : undefined,
        50,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const imports = importsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const latestImport = imports[0];

  useEffect(() => {
    if (selectedImportId === null && latestImport) {
      setSelectedImportId(latestImport.import_id);
      return;
    }
    if (
      selectedImportId !== null &&
      !imports.some((item) => item.import_id === selectedImportId)
    ) {
      setSelectedImportId(latestImport?.import_id ?? null);
    }
  }, [imports, latestImport, selectedImportId]);

  const detailQuery = useQuery({
    queryKey: queryKeys.historyImport(
      selectedImportId ?? "",
      account.identity_id,
    ),
    queryFn: () =>
      apiClient.getHistoryImport(selectedImportId ?? "", account.identity_id),
    enabled: selectedImportId !== null,
  });
  const detail = detailQuery.data;
  const item = detail?.import ?? latestImport;

  const invalidateHistory = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.historyImports(
        account.account_id,
        account.identity_id,
      ),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.historyCapabilities(
        account.account_id,
        account.identity_id,
      ),
    });
    if (selectedImportId !== null) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.historyImport(
          selectedImportId,
          account.identity_id,
        ),
      });
    }
  };

  const startMutation = useMutation({
    mutationFn: () => {
      const parsedMaxEvents = Number(maxEvents);
      if (
        !Number.isSafeInteger(parsedMaxEvents) ||
        parsedMaxEvents < 1 ||
        parsedMaxEvents > 100_000
      ) {
        throw new Error("Events per batch must be between 1 and 100,000");
      }
      const start = toIsoTimestamp(startAt, "Start date");
      const end = toIsoTimestamp(endAt, "End date");
      if (Date.parse(start) >= Date.parse(end)) {
        throw new Error("End date must be after the start date");
      }
      return apiClient.startHistoryImport(
        account.account_id,
        {
          identity_id: account.identity_id,
          start_at: start,
          end_at: end,
          max_events: parsedMaxEvents,
        },
        newIdempotencyKey(),
      );
    },
    onSuccess: (result: HistoryImportDetail) => {
      setSelectedImportId(result.import.import_id);
      invalidateHistory();
    },
  });

  const advanceMutation = useMutation({
    mutationFn: (rangeId?: string) =>
      apiClient.advanceHistoryImport(
        selectedImportId ?? "",
        {
          identity_id: account.identity_id,
          ...(rangeId === undefined ? {} : { range_id: rangeId }),
        },
        newIdempotencyKey(),
      ),
    onSuccess: (result: HistoryImportDetail) => {
      setSelectedImportId(result.import.import_id);
      invalidateHistory();
    },
  });

  const pendingRange = detail?.ranges.find(
    (range) => range.status === "active" || range.status === "pending",
  );

  return (
    <article className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {titleCase(account.provider)} · Linked account
          </p>
          <h3 className="mt-1 text-xl font-semibold">
            {account.display_label} history
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Account {account.account_id} · Identity {account.identity_id}
          </p>
        </div>
        <Badge variant={badgeVariant(account.status)}>
          {titleCase(account.status)} account
        </Badge>
      </div>

      <details className="mt-5 rounded-lg border p-3" open>
        <summary className="cursor-pointer font-medium">
          Capability proof and provider state
        </summary>
        <div className="mt-3">
          {capabilitiesQuery.isLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading capability evidence…
            </p>
          )}
          {capabilitiesQuery.isError && (
            <p role="alert" className="text-sm text-destructive">
              Unable to load capability evidence for this account.
            </p>
          )}
          {capabilitiesQuery.data && (
            <CapabilityProof capabilities={capabilitiesQuery.data} />
          )}
        </div>
      </details>

      <section
        aria-labelledby={`${account.account_id}-history-heading`}
        className="mt-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4
              id={`${account.account_id}-history-heading`}
              className="font-semibold"
            >
              History import progress
            </h4>
            <p className="mt-1 text-sm text-muted-foreground">
              Requested ranges stay separate from provider batches, so advancing
              a batch never limits the requested history.
            </p>
          </div>
          {pendingRange && canManage && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={advanceMutation.isPending}
              onClick={() => advanceMutation.mutate()}
            >
              {advanceMutation.isPending ? "Advancing…" : "Advance next range"}
            </Button>
          )}
        </div>

        {importsQuery.isLoading && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Loading import progress…
          </p>
        )}
        {importsQuery.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Unable to load history import progress for this account.
          </p>
        )}
        {imports.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recorded imports
            </p>
            <div
              className="flex flex-wrap gap-2"
              aria-label="Recorded history imports"
            >
              {imports.map((historyImport) => (
                <Button
                  key={historyImport.import_id}
                  type="button"
                  size="sm"
                  variant={
                    historyImport.import_id === selectedImportId
                      ? "secondary"
                      : "outline"
                  }
                  onClick={() => setSelectedImportId(historyImport.import_id)}
                >
                  {historyImport.import_id} · {titleCase(historyImport.status)}
                </Button>
              ))}
            </div>
            {importsQuery.hasNextPage && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={importsQuery.isFetchingNextPage}
                onClick={() => void importsQuery.fetchNextPage()}
              >
                {importsQuery.isFetchingNextPage
                  ? "Loading more imports…"
                  : "Load more imports"}
              </Button>
            )}
          </div>
        )}
        {!importsQuery.isLoading && !importsQuery.isError && !item && (
          <p className="mt-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Not imported yet. Stored reads will identify this range as not
            imported, even when the chat itself has no messages.
          </p>
        )}
        {item && (
          <div className="mt-3 space-y-3">
            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Import {item.import_id}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatTimestamp(item.requested_start_at)} –{" "}
                    {formatTimestamp(item.requested_end_at)}
                  </p>
                </div>
                <Badge variant={badgeVariant(item.status)}>
                  {titleCase(item.status)}
                </Badge>
              </div>
              <Progress
                className="mt-3"
                value={progressPercent(item)}
                aria-label="History range progress"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {item.completed_range_count} of {item.total_range_count} ranges
                complete · {item.event_count} events · {item.gap_count} known
                gap{item.gap_count === 1 ? "" : "s"}
              </p>
              {item.status === "partial" && (
                <p className="mt-2 text-sm text-amber-800">
                  Partial coverage remains visible; known gaps were not
                  presented as complete history.
                </p>
              )}
              {item.status === "failed" && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  Import stopped with{" "}
                  {titleCase(item.last_error_code ?? "provider_error")}.
                </p>
              )}
              {item.status === "completed" && item.event_count === 0 && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Provider reported no messages in the requested range (empty).
                </p>
              )}
            </div>

            {detailQuery.isLoading && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading range details…
              </p>
            )}
            {detailQuery.isError && (
              <p role="alert" className="text-sm text-destructive">
                Unable to load range details for this import.
              </p>
            )}
            {detail && (
              <ol
                className="space-y-2"
                aria-label={`Ranges for ${item.import_id}`}
              >
                {detail.ranges.map((range) => (
                  <RangeRow
                    key={range.range_id}
                    range={range}
                    canManage={canManage}
                    canAdvance={
                      range.status === "active" || range.status === "pending"
                    }
                    isAdvancing={advanceMutation.isPending}
                    onAdvance={() => advanceMutation.mutate(range.range_id)}
                  />
                ))}
              </ol>
            )}
          </div>
        )}
      </section>

      {canManage ? (
        <form
          className="mt-5 grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            startMutation.mutate();
          }}
        >
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="font-medium">Start a history range</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose the coverage window explicitly. The batch size only bounds
              one resumable provider step.
            </p>
          </div>
          <label className="grid gap-1 text-sm font-medium">
            Start date
            <input
              aria-label={`History start for ${account.display_label}`}
              type="datetime-local"
              required
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
              className="h-9 rounded-md border bg-background px-2"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            End date
            <input
              aria-label={`History end for ${account.display_label}`}
              type="datetime-local"
              required
              value={endAt}
              onChange={(event) => setEndAt(event.target.value)}
              className="h-9 rounded-md border bg-background px-2"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Events per batch
            <input
              aria-label={`History batch size for ${account.display_label}`}
              type="number"
              min={1}
              max={100_000}
              required
              value={maxEvents}
              onChange={(event) => setMaxEvents(event.target.value)}
              className="h-9 rounded-md border bg-background px-2"
            />
          </label>
          <div className="flex items-end">
            <Button
              type="submit"
              className="w-full"
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? "Starting…" : "Start import"}
            </Button>
          </div>
          {startMutation.isError && (
            <p
              role="alert"
              className="sm:col-span-2 lg:col-span-4 text-sm text-destructive"
            >
              {startMutation.error instanceof Error
                ? startMutation.error.message
                : "History import could not be started."}
            </p>
          )}
        </form>
      ) : (
        <p className="mt-5 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Import controls require an administrator identity with connection
          management permission. Capability and progress state remain readable
          here.
        </p>
      )}
    </article>
  );
}

export function HistoryImportPanel({
  accounts,
  accountsHasNextPage,
  accountsFetchingNextPage,
  onLoadMoreAccounts,
  session,
}: {
  accounts: readonly ConnectedAccount[];
  accountsHasNextPage: boolean | undefined;
  accountsFetchingNextPage: boolean;
  onLoadMoreAccounts: () => void;
  session: SessionResponse | undefined;
}) {
  if (!isAdministrator(session)) return null;
  return (
    <section
      aria-labelledby="history-import-management-heading"
      className="space-y-4"
    >
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          Provider state and coverage
        </p>
        <h2
          id="history-import-management-heading"
          className="mt-1 text-xl font-semibold"
        >
          History imports
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Review proof-backed capabilities and resumable coverage for each
          linked account. Empty, not imported, partial, and failed states stay
          distinct.
        </p>
      </div>
      {accounts.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No linked accounts are available for history management.
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {accounts.map((account) => (
          <HistoryImportAccountCard
            key={account.account_id}
            account={account}
            session={session}
          />
        ))}
      </div>
      {accountsHasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={accountsFetchingNextPage}
          onClick={onLoadMoreAccounts}
        >
          {accountsFetchingNextPage
            ? "Loading more linked accounts…"
            : "Load more linked accounts"}
        </Button>
      )}
    </section>
  );
}

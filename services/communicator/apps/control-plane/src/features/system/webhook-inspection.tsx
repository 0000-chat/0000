import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import type { WebhookSubscription } from "@communicator/contracts";
import { useIdentityContext } from "@/components/identity/identity-switcher";
import { Button } from "@/components/ui/button";
import {
  apiClient,
  ApiError,
  isDefinitiveRequestRejection,
} from "@/lib/api/client";

function inspectionError(error: unknown) {
  if (error instanceof ApiError && error.status === 403)
    return "Permission denied. Your current session cannot inspect or retry this webhook.";
  if (error instanceof ApiError && error.status === 404)
    return "Delivery not found or no longer visible to this session.";
  return "Unable to load webhook data. Refresh and try again.";
}

function SubscriptionInspection({
  subscription,
}: {
  subscription: WebhookSubscription;
}) {
  const queryClient = useQueryClient();
  const [deliveryId, setDeliveryId] = useState("");
  const deliveriesKey = ["webhook-deliveries", subscription.id];
  const deliveries = useInfiniteQuery({
    queryKey: deliveriesKey,
    queryFn: ({ pageParam }) =>
      apiClient.getWebhookDeliveries(subscription.id, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  });
  const [retryKey, setRetryKey] = useState(
    () => `ui-webhook-${crypto.randomUUID()}`,
  );
  const queryKey = ["webhook-delivery", subscription.id, deliveryId];
  const deliveryQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const delivery = await apiClient.getWebhookDelivery(deliveryId);
      if (delivery.subscription_id !== subscription.id)
        throw new ApiError(
          409,
          "This delivery belongs to a different subscription. Inspect it under that subscription instead.",
        );
      return delivery;
    },
    enabled: deliveryId.length > 0,
  });
  const retry = useMutation({
    mutationFn: () => apiClient.retryWebhookDelivery(deliveryId, retryKey),
    onSuccess: (delivery) => {
      queryClient.setQueryData(queryKey, delivery);
      void queryClient.invalidateQueries({ queryKey: deliveriesKey });
      setRetryKey(`ui-webhook-${crypto.randomUUID()}`);
    },
  });
  const delivery =
    deliveryQuery.isError || deliveries.isError
      ? undefined
      : deliveryQuery.data;
  const retryable =
    delivery &&
    subscription.status === "active" &&
    subscription.destination_version === delivery.destination_version &&
    (delivery.status === "failed" || delivery.status === "uncertain");

  return (
    <article
      aria-label={`Subscription ${subscription.id}`}
      className="min-w-0 space-y-3 rounded-lg border p-4 text-sm"
    >
      <h3 className="break-all font-semibold">{subscription.id}</h3>
      <p className="break-all">
        Destination: {subscription.destination.url} · version{" "}
        {subscription.destination_version}
      </p>
      <p>
        Status: {subscription.status} · Global default:{" "}
        {subscription.global_enabled ? "enabled" : "disabled"}
      </p>
      <p className="break-all">
        Owner: {subscription.owner_principal_id} · {subscription.ownership_mode}
      </p>
      <p>Event types: {subscription.event_filter.event_types.join(", ")}</p>
      <details>
        <summary className="cursor-pointer font-medium">
          Account and chat overrides
        </summary>
        <p className="mt-2 text-muted-foreground">
          Chat overrides take precedence over account overrides, then the global
          default. Current grants still apply.
        </p>
        {subscription.account_rules.length === 0 &&
          subscription.chat_rules.length === 0 && <p>No overrides.</p>}
        <ul className="break-all">
          {subscription.account_rules.map((rule) => (
            <li key={rule.account_id}>
              Account {rule.account_id}: {rule.enabled ? "enabled" : "disabled"}
            </li>
          ))}
          {subscription.chat_rules.map((rule) => (
            <li key={`${rule.account_id}:${rule.chat_id}`}>
              Account {rule.account_id} · Chat {rule.chat_id}:{" "}
              {rule.enabled ? "enabled" : "disabled"}
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Deliveries</h4>
        <Button
          type="button"
          variant="outline"
          disabled={deliveries.isFetching || retry.isPending}
          onClick={() => {
            setDeliveryId("");
            retry.reset();
            void queryClient.resetQueries({ queryKey: deliveriesKey });
          }}
        >
          Refresh deliveries
        </Button>
      </div>
      <p className="text-muted-foreground">
        Stable delivery ID order. Select a delivery to inspect its current
        state.
      </p>
      {deliveries.isLoading && <p role="status">Loading deliveries…</p>}
      {deliveries.isError && (
        <p role="alert">
          {deliveries.error instanceof ApiError &&
          deliveries.error.status === 409
            ? "Deliveries changed after removal. Refresh deliveries to restart discovery."
            : inspectionError(deliveries.error)}
        </p>
      )}
      {!deliveries.isError && (
        <ul aria-label="Delivery list" className="space-y-2">
          {deliveries.data?.pages
            .flatMap((page) => page.items)
            .map((item) => (
              <li key={item.id}>
                <Button
                  type="button"
                  variant={deliveryId === item.id ? "secondary" : "outline"}
                  className="h-auto w-full justify-start whitespace-normal break-all text-left"
                  aria-pressed={deliveryId === item.id}
                  disabled={retry.isPending}
                  onClick={() => {
                    retry.reset();
                    setRetryKey(`ui-webhook-${crypto.randomUUID()}`);
                    if (deliveryId === item.id) void deliveryQuery.refetch();
                    else setDeliveryId(item.id);
                  }}
                >
                  {item.id} · {item.status} · {item.attempt_count} attempts ·
                  destination v{item.destination_version}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {!deliveries.isError &&
        deliveries.data?.pages.every((page) => page.items.length === 0) && (
          <p>No deliveries for this subscription.</p>
        )}
      {!deliveries.isError && deliveries.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          disabled={deliveries.isFetchingNextPage || retry.isPending}
          onClick={() => void deliveries.fetchNextPage()}
        >
          Load more deliveries
        </Button>
      )}
      {deliveryQuery.isFetching && <p role="status">Loading delivery…</p>}
      {deliveryQuery.isError && (
        <p role="alert">
          {deliveryQuery.error instanceof ApiError &&
          deliveryQuery.error.status === 409
            ? deliveryQuery.error.message
            : inspectionError(deliveryQuery.error)}
        </p>
      )}
      {delivery && (
        <div
          aria-label="Webhook delivery details"
          className="space-y-2 rounded-md border p-3"
        >
          <p className="break-all font-medium">
            {delivery.id} · {delivery.status}
          </p>
          <dl className="grid gap-2 break-all sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Source event</dt>
              <dd>{delivery.source_event_id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Attempts / HTTP status</dt>
              <dd>
                {delivery.attempt_count} / {delivery.http_status ?? "none"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">First pending</dt>
              <dd>{delivery.first_pending_at}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                Automatic retry deadline (24 hours)
              </dt>
              <dd>{delivery.retry_deadline}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Next attempt</dt>
              <dd>{delivery.next_attempt_at ?? "none scheduled"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Failure / uncertainty</dt>
              <dd>
                {[
                  delivery.error_code,
                  delivery.uncertainty_reason,
                  delivery.cancellation_reason,
                ]
                  .filter(Boolean)
                  .join(" · ") || "none"}
              </dd>
            </div>
          </dl>
          {delivery.status === "uncertain" && (
            <p>
              Webhook delivery is uncertain. Retrying may duplicate the webhook
              event at its destination.
            </p>
          )}
          <p className="text-muted-foreground">
            Webhook retry is not a message resend and does not establish
            provider delivery. The original retry deadline is retained.
          </p>
          {delivery.destination_version !==
            subscription.destination_version && (
            <p>
              Retry is unavailable: this delivery used destination version{" "}
              {delivery.destination_version}, not the current version{" "}
              {subscription.destination_version}.
            </p>
          )}
          {retryable && (
            <Button
              type="button"
              disabled={retry.isPending || deliveryQuery.isFetching}
              onClick={() => {
                if (
                  window.confirm(
                    "Retry this webhook delivery? The receiver may have already processed it. This does not resend the message or reset the 24-hour window.",
                  )
                )
                  retry.mutate();
              }}
            >
              {retry.isPending ? "Requesting retry…" : "Retry webhook delivery"}
            </Button>
          )}
          {retry.isSuccess && (
            <p role="status">
              Retry requested. Inspect again for its outcome; this is not a
              delivery receipt.
            </p>
          )}
          {retry.isError && (
            <p role="alert">
              {retry.error instanceof ApiError && retry.error.status === 403
                ? inspectionError(retry.error)
                : isDefinitiveRequestRejection(retry.error)
                  ? "Retry rejected. Inspect the current delivery; its state or subscription may have changed."
                  : "Retry was not confirmed. Inspect the delivery before retrying; it may already have been accepted."}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function WebhookInspection() {
  const { session, authStatus, isLoading } = useIdentityContext();
  const allowed =
    authStatus === "authenticated" &&
    (session?.membership.role === "owner" ||
      session?.membership.role === "admin") &&
    (session?.principal.type === "human" ||
      session?.principal.type === "operator");
  const subscriptions = useInfiniteQuery({
    queryKey: ["webhook-subscriptions"],
    queryFn: ({ pageParam }) =>
      apiClient.getWebhookSubscriptions(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: allowed,
  });
  return (
    <section
      aria-labelledby="webhook-heading"
      className="space-y-4 rounded-xl border bg-card p-5"
    >
      <h2 id="webhook-heading" className="text-xl font-semibold">
        Webhook inspection
      </h2>
      <p className="text-sm text-muted-foreground">
        Discover and inspect each subscription’s deliveries independently.
        Automatic webhook retries have a separate 24-hour window, not the
        four-hour offline message confirmation deadline.
      </p>
      {isLoading && <p role="status">Loading session…</p>}
      {!isLoading && !allowed && (
        <p role="status">
          Administrator permission is required to inspect webhooks.
        </p>
      )}
      {allowed && subscriptions.isLoading && (
        <p role="status">Loading subscriptions…</p>
      )}
      {allowed && subscriptions.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{inspectionError(subscriptions.error)}</p>
          <Button
            variant="outline"
            onClick={() => void subscriptions.refetch()}
          >
            Refresh subscriptions
          </Button>
        </div>
      )}
      {allowed &&
        !subscriptions.isError &&
        subscriptions.data?.pages
          .flatMap((page) => page.items)
          .map((subscription) => (
            <SubscriptionInspection
              key={subscription.id}
              subscription={subscription}
            />
          ))}
      {allowed &&
        !subscriptions.isError &&
        subscriptions.data?.pages.every((page) => page.items.length === 0) && (
          <p>No webhook subscriptions are available.</p>
        )}
      {allowed && subscriptions.hasNextPage && (
        <Button
          variant="outline"
          disabled={subscriptions.isFetchingNextPage}
          onClick={() => void subscriptions.fetchNextPage()}
        >
          Load more subscriptions
        </Button>
      )}
    </section>
  );
}

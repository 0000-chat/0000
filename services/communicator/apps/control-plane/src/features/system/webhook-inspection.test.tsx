import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { simulatedStore } from "@/mocks/store";
import { server } from "@/mocks/server";
import { webhookSubscriptions } from "@/mocks/webhook-fixtures";
import { queryKeys } from "@/lib/api/query-keys";

afterEach(() => vi.restoreAllMocks());

describe("webhook discovery and inspection", () => {
  it.each(["binding", "tenant", "principal", "membership"] as const)(
    "does not reuse webhook data or selection after a changed %s is accepted",
    async (changed) => {
      const user = userEvent.setup();
      const original = {
        ...simulatedStore.session(),
        binding_id: "binding_webhook_original",
      };
      server.use(
        http.get("*/api/v1/session", () => HttpResponse.json(original)),
      );
      const { queryClient } = renderApp("/system");
      const audit = await screen.findByRole("article", {
        name: "Subscription subscription_audit",
      });
      await user.click(
        await within(audit).findByRole("button", {
          name: /delivery_audit · uncertain/,
        }),
      );
      expect(
        await within(audit).findByLabelText("Webhook delivery details"),
      ).toBeVisible();
      let release = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const next = {
        ...original,
        binding_id:
          changed === "binding" ? "binding_webhook_next" : original.binding_id,
        tenant: {
          ...original.tenant,
          id: changed === "tenant" ? "tenant_next" : original.tenant.id,
        },
        principal: {
          ...original.principal,
          id:
            changed === "principal" ? "principal_next" : original.principal.id,
        },
        membership: {
          ...original.membership,
          id:
            changed === "membership"
              ? "membership_next"
              : original.membership.id,
        },
      };
      const subscription = webhookSubscriptions().find(
        (item) => item.id === "subscription_audit",
      )!;
      server.use(
        http.get("*/api/v1/session", () => HttpResponse.json(next)),
        http.get("*/api/v1/webhook-subscriptions", async () => {
          await pending;
          return HttpResponse.json({
            items: [subscription],
            next_cursor: null,
          });
        }),
        http.get("*/api/v1/webhook-subscriptions/:id/deliveries", () =>
          HttpResponse.json({ items: [], next_cursor: null }),
        ),
      );
      await act(async () => {
        queryClient.setQueryData(queryKeys.session, next);
      });
      const resume = await screen.findByRole("button", {
        name: "Review and continue",
      });
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
      try {
        await user.click(resume);
        expect(screen.queryByRole("article")).not.toBeInTheDocument();
        expect(
          screen.queryByLabelText("Webhook delivery details"),
        ).not.toBeInTheDocument();
      } finally {
        release();
      }
      const nextAudit = await screen.findByRole("article", {
        name: "Subscription subscription_audit",
      });
      expect(
        await within(nextAudit).findByText(
          "No deliveries for this subscription.",
        ),
      ).toBeVisible();
      expect(
        within(nextAudit).queryByLabelText("Webhook delivery details"),
      ).not.toBeInTheDocument();
      expect(
        within(nextAudit).queryByRole("button", {
          name: "Retry webhook delivery",
        }),
      ).not.toBeInTheDocument();
    },
  );

  it("rejects a selected delivery that now resolves to another subscription", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/webhook-deliveries/:id", () =>
        HttpResponse.json(
          simulatedStore.webhookDeliveries.find(
            (item) => item.id === "delivery_support",
          ),
        ),
      ),
    );
    renderApp("/system");
    const audit = await screen.findByRole("article", {
      name: "Subscription subscription_audit",
    });
    await user.click(
      await within(audit).findByRole("button", {
        name: /delivery_audit · uncertain/,
      }),
    );
    expect(await within(audit).findByRole("alert")).toHaveTextContent(
      "different subscription",
    );
    expect(
      within(audit).queryByLabelText("Webhook delivery details"),
    ).not.toBeInTheDocument();
    expect(
      within(audit).queryByRole("button", { name: "Retry webhook delivery" }),
    ).not.toBeInTheDocument();
  });

  it("keeps subscription pagination, delivery pagination, selection and retry independent", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const original = simulatedStore.webhookDeliveries.find(
      (item) => item.id === "delivery_audit",
    )!;
    renderApp("/system");
    const audit = await screen.findByRole("article", {
      name: "Subscription subscription_audit",
    });
    await user.click(
      await within(audit).findByRole("button", {
        name: /delivery_audit · uncertain/,
      }),
    );
    expect(
      await within(audit).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit · uncertain");
    await user.click(
      within(audit).getByRole("button", { name: "Load more deliveries" }),
    );
    expect(
      await within(audit).findByRole("button", {
        name: /delivery_audit_z · delivered/,
      }),
    ).toBeVisible();
    expect(
      within(audit).getByRole("button", { name: /delivery_audit · uncertain/ }),
    ).toHaveAttribute("aria-pressed", "true");
    const delivered = within(audit).getByRole("button", {
      name: /delivery_audit_z · delivered/,
    });
    await user.click(delivered);
    expect(
      await within(audit).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit_z · delivered");
    expect(delivered).toHaveAttribute("aria-pressed", "true");
    expect(
      within(audit).queryByRole("button", { name: "Retry webhook delivery" }),
    ).not.toBeInTheDocument();
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(
      await within(audit).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit · uncertain");
    expect(delivered).toHaveAttribute("aria-pressed", "false");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(
      await within(audit).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit_z · delivered");
    await user.click(
      within(audit).getByRole("button", { name: /delivery_audit · uncertain/ }),
    );
    expect(
      await within(audit).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit · uncertain");
    await user.click(
      screen.getByRole("button", { name: "Load more subscriptions" }),
    );
    const support = await screen.findByRole("article", {
      name: "Subscription subscription_support",
    });
    await user.click(
      await within(support).findByRole("button", {
        name: /delivery_support · failed/,
      }),
    );
    expect(
      await within(support).findByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_support · failed");
    await user.click(
      within(audit).getByRole("button", { name: "Retry webhook delivery" }),
    );
    expect(original.status).toBe("uncertain");
    confirm.mockReturnValue(true);
    await user.click(
      within(audit).getByRole("button", { name: "Retry webhook delivery" }),
    );
    expect(await within(audit).findByRole("status")).toHaveTextContent(
      "not a delivery receipt",
    );
    expect(
      within(audit).getByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_audit · pending");
    expect(within(audit).getByText(original.retry_deadline)).toBeVisible();
    expect(
      within(support).getByLabelText("Webhook delivery details"),
    ).toHaveTextContent("delivery_support · failed");
  });

  it("does not offer old backlog retry after destination cutover", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/webhook-subscriptions", () =>
        HttpResponse.json({
          items: webhookSubscriptions().map((item) => ({
            ...item,
            destination_version: 2,
          })),
          next_cursor: null,
        }),
      ),
    );
    renderApp("/system");
    const audit = await screen.findByRole("article", {
      name: "Subscription subscription_audit",
    });
    await user.click(
      await within(audit).findByRole("button", {
        name: /delivery_audit · uncertain/,
      }),
    );
    expect(
      await within(audit).findByText(
        /Retry is unavailable: this delivery used destination version 1/,
      ),
    ).toBeVisible();
    expect(
      within(audit).queryByRole("button", { name: "Retry webhook delivery" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { status: 403, expected: "Permission denied." },
    { status: 409, expected: "Retry rejected." },
    { status: 502, expected: "Retry was not confirmed." },
  ])(
    "distinguishes retry rejection and unknown outcome ($status)",
    async ({ status, expected }) => {
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      server.use(
        http.post("*/api/v1/webhook-deliveries/:id/retry", () =>
          HttpResponse.json(
            {
              error: { code: "invalid_request", message: "Synthetic failure" },
            },
            { status },
          ),
        ),
      );
      renderApp("/system");
      const audit = await screen.findByRole("article", {
        name: "Subscription subscription_audit",
      });
      await user.click(
        await within(audit).findByRole("button", {
          name: /delivery_audit · uncertain/,
        }),
      );
      await user.click(
        await within(audit).findByRole("button", {
          name: "Retry webhook delivery",
        }),
      );
      expect(await within(audit).findByRole("alert")).toHaveTextContent(
        expected,
      );
      expect(
        within(audit).getByLabelText("Webhook delivery details"),
      ).toHaveTextContent("delivery_audit · uncertain");
    },
  );

  it.each([403, 502, 409])(
    "hides stale details on a rejected delivery page and recovers with refresh (%s)",
    async (status) => {
      const user = userEvent.setup();
      renderApp("/system");
      const audit = await screen.findByRole("article", {
        name: "Subscription subscription_audit",
      });
      await user.click(
        await within(audit).findByRole("button", {
          name: /delivery_audit · uncertain/,
        }),
      );
      expect(
        await within(audit).findByLabelText("Webhook delivery details"),
      ).toBeVisible();
      server.use(
        http.get("*/api/v1/webhook-subscriptions/:id/deliveries", () =>
          HttpResponse.json(
            { error: { code: "forbidden", message: "Synthetic denial" } },
            { status },
          ),
        ),
      );
      await user.click(
        within(audit).getByRole("button", { name: "Refresh deliveries" }),
      );
      expect(await within(audit).findByRole("alert")).toHaveTextContent(
        status === 403
          ? "Permission denied"
          : status === 409
            ? "Refresh deliveries to restart"
            : "Unable to load webhook data",
      );
      expect(
        within(audit).queryByLabelText("Webhook delivery details"),
      ).not.toBeInTheDocument();
      expect(
        within(audit).queryByRole("button", { name: "Retry webhook delivery" }),
      ).not.toBeInTheDocument();
      server.resetHandlers();
      await user.click(
        within(audit).getByRole("button", { name: "Refresh deliveries" }),
      );
      expect(
        await within(audit).findByRole("button", {
          name: /delivery_audit · uncertain/,
        }),
      ).toBeVisible();
    },
  );

  it("renders empty deliveries without hiding another subscription", async () => {
    simulatedStore.webhookDeliveries = simulatedStore.webhookDeliveries.filter(
      (item) => item.subscription_id !== "subscription_audit",
    );
    renderApp("/system");
    expect(
      await screen.findByText("No deliveries for this subscription."),
    ).toBeVisible();
    expect(screen.queryByLabelText("Delivery ID")).not.toBeInTheDocument();
  });

  it("renders empty subscriptions", async () => {
    server.use(
      http.get("*/api/v1/webhook-subscriptions", () =>
        HttpResponse.json({ items: [], next_cursor: null }),
      ),
    );
    renderApp("/system");
    expect(
      await screen.findByText("No webhook subscriptions are available."),
    ).toBeVisible();
  });

  it("does not query administrator data for a member", async () => {
    let reads = 0;
    server.use(
      http.get("*/api/v1/session", () => {
        const session = simulatedStore.session();
        return HttpResponse.json({
          ...session,
          membership: { ...session.membership, role: "member" },
        });
      }),
      http.get("*/api/v1/webhook-subscriptions", () => {
        reads += 1;
        return HttpResponse.error();
      }),
    );
    renderApp("/system");
    expect(
      await screen.findByText(
        "Administrator permission is required to inspect webhooks.",
      ),
    ).toBeVisible();
    expect(reads).toBe(0);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("recovers a failed subscription read", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/api/v1/webhook-subscriptions", () =>
        HttpResponse.json(
          { error: { code: "forbidden", message: "Denied" } },
          { status: 403 },
        ),
      ),
    );
    renderApp("/system");
    expect(await screen.findByText(/Permission denied/)).toBeVisible();
    server.resetHandlers();
    await user.click(
      screen.getByRole("button", { name: "Refresh subscriptions" }),
    );
    expect(
      await screen.findByRole("article", {
        name: "Subscription subscription_audit",
      }),
    ).toBeVisible();
  });
});

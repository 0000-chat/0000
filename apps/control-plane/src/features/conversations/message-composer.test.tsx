import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/app/providers";
import { apiClient } from "@/lib/api/client";
import { MessageComposer } from "./message-composer";

describe("MessageComposer", () => {
  it("disables every sending control when the channel cannot send", async () => {
    const user = userEvent.setup();
    const sendMessage = vi.spyOn(apiClient, "sendMessage");
    const queryClient = createAppQueryClient(true);
    render(
      <QueryClientProvider client={queryClient}>
        <MessageComposer
          identityId="identity_human"
          conversationId="conversation_human_messenger_studio"
          canSend={false}
          unavailableReason="Sending is unavailable until this connection is repaired."
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Delivery mode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Sending is unavailable until this connection is repaired.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessage).not.toHaveBeenCalled();
    sendMessage.mockRestore();
  });
});

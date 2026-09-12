import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "./provider-icon";

describe("ProviderIcon", () => {
  it.each(["whatsapp", "telegram", "messenger", "linkedin"])(
    "renders a local branded svg for %s",
    (provider) => {
      render(<ProviderIcon provider={provider} />);

      const icon = screen.getByTestId(`provider-icon-${provider}`);
      expect(icon.tagName.toLowerCase()).toBe("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveAttribute("focusable", "false");
    },
  );

  it("renders an accessible generic fallback for an unknown provider", () => {
    render(<ProviderIcon provider="future-network" />);

    expect(screen.getByTestId("provider-icon-fallback")).toBeInTheDocument();
  });
});

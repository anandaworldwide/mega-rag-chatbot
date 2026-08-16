import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import HelpDropdown from "@/components/HelpDropdown";

describe("HelpDropdown", () => {
  it("renders a named Help link that Voice Control can target", () => {
    render(<HelpDropdown helpUrl="https://example.com/help" />);

    const help = screen.getByRole("link", { name: "Help" });
    expect(help).toBeInTheDocument();
    expect(help).not.toHaveAttribute("aria-hidden");
    expect(help).toHaveAttribute("href", "https://example.com/help");
    expect(screen.getByText("help_outline")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders nothing when helpUrl is missing", () => {
    const { container } = render(<HelpDropdown />);
    expect(container).toBeEmptyDOMElement();
  });
});

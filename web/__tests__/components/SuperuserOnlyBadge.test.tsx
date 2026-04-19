import React from "react";
import { render, screen } from "@testing-library/react";
import { SuperuserOnlyBadge } from "@/components/SuperuserOnlyBadge";

describe("SuperuserOnlyBadge", () => {
  it("renders label, status role, and tooltip title", () => {
    render(<SuperuserOnlyBadge />);

    expect(screen.getByText("Superuser only")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Superuser-only page" })).toBeInTheDocument();
    expect(screen.getByTitle("Only superusers can access this page.")).toBeInTheDocument();
  });
});

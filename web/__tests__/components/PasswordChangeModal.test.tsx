import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PasswordChangeModal } from "@/components/PasswordChangeModal";

describe("PasswordChangeModal", () => {
  const mockOnClose = jest.fn();
  const mockOnPasswordChanged = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it("does not render when closed", () => {
    render(
      <PasswordChangeModal
        isOpen={false}
        onClose={mockOnClose}
        hasPassword={false}
        onPasswordChanged={mockOnPasswordChanged}
      />
    );
    expect(screen.queryByText("Set Password")).not.toBeInTheDocument();
  });

  it("shows set password title when user has no password", () => {
    render(
      <PasswordChangeModal
        isOpen={true}
        onClose={mockOnClose}
        hasPassword={false}
        onPasswordChanged={mockOnPasswordChanged}
      />
    );
    expect(screen.getByRole("heading", { name: "Set Password" })).toBeInTheDocument();
  });

  it("shows validation error when passwords do not match", async () => {
    render(
      <PasswordChangeModal
        isOpen={true}
        onClose={mockOnClose}
        hasPassword={false}
        onPasswordChanged={mockOnPasswordChanged}
      />
    );

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "SecurePass1" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "Different1" } });
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));

    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
  });

  it("shows validation error for weak password", async () => {
    render(
      <PasswordChangeModal
        isOpen={true}
        onClose={mockOnClose}
        hasPassword={false}
        onPasswordChanged={mockOnPasswordChanged}
      />
    );

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));

    expect(await screen.findByText("Password must be at least 8 characters")).toBeInTheDocument();
  });

  it("submits successfully when setting a new password", async () => {
    jest.mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "jwt-token" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: "ok" }),
      } as Response);

    render(
      <PasswordChangeModal
        isOpen={true}
        onClose={mockOnClose}
        hasPassword={false}
        onPasswordChanged={mockOnPasswordChanged}
      />
    );

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "SecurePass1" } });
    fireEvent.change(screen.getByLabelText("Confirm Password"), { target: { value: "SecurePass1" } });
    fireEvent.click(screen.getByRole("button", { name: "Set Password" }));

    await waitFor(() => {
      expect(mockOnPasswordChanged).toHaveBeenCalledWith("Password set successfully");
    });
  });
});

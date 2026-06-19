import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailChangeModal } from "@/components/EmailChangeModal";

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

import { fetchWithAuth } from "@/utils/client/tokenManager";

const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

describe("EmailChangeModal", () => {
  const mockOnClose = jest.fn();
  const mockOnEmailChangeRequested = jest.fn();
  const mockOnEmailChangeCancelled = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  it("does not render when closed", () => {
    render(
      <EmailChangeModal
        isOpen={false}
        onClose={mockOnClose}
        currentEmail="user@example.com"
        pendingEmail={null}
        onEmailChangeRequested={mockOnEmailChangeRequested}
        onEmailChangeCancelled={mockOnEmailChangeCancelled}
      />
    );
    expect(screen.queryByText("Change Email Address")).not.toBeInTheDocument();
  });

  it("shows validation error when new email is empty", async () => {
    render(
      <EmailChangeModal
        isOpen={true}
        onClose={mockOnClose}
        currentEmail="user@example.com"
        pendingEmail={null}
        onEmailChangeRequested={mockOnEmailChangeRequested}
        onEmailChangeCancelled={mockOnEmailChangeCancelled}
      />
    );

    fireEvent.submit(screen.getByRole("button", { name: "Send Verification Email" }).closest("form")!);
    expect(await screen.findByText("Please enter a new email address")).toBeInTheDocument();
  });

  it("shows validation error when new email matches current email", async () => {
    render(
      <EmailChangeModal
        isOpen={true}
        onClose={mockOnClose}
        currentEmail="user@example.com"
        pendingEmail={null}
        onEmailChangeRequested={mockOnEmailChangeRequested}
        onEmailChangeCancelled={mockOnEmailChangeCancelled}
      />
    );

    fireEvent.change(screen.getByLabelText("New email address"), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Verification Email" }));

    expect(await screen.findByText("New email must be different from current email")).toBeInTheDocument();
  });

  it("submits email change request successfully", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: "ok" }),
    } as Response);

    render(
      <EmailChangeModal
        isOpen={true}
        onClose={mockOnClose}
        currentEmail="user@example.com"
        pendingEmail={null}
        onEmailChangeRequested={mockOnEmailChangeRequested}
        onEmailChangeCancelled={mockOnEmailChangeCancelled}
      />
    );

    fireEvent.change(screen.getByLabelText("New email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Verification Email" }));

    await waitFor(() => {
      expect(mockOnEmailChangeRequested).toHaveBeenCalledWith("new@example.com");
    });
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/requestEmailChange",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("cancels pending email change", async () => {
    jest.mocked(global.fetch).mockResolvedValueOnce({ ok: true } as Response);

    render(
      <EmailChangeModal
        isOpen={true}
        onClose={mockOnClose}
        currentEmail="user@example.com"
        pendingEmail="pending@example.com"
        onEmailChangeRequested={mockOnEmailChangeRequested}
        onEmailChangeCancelled={mockOnEmailChangeCancelled}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel Email Change" }));

    await waitFor(() => {
      expect(mockOnEmailChangeCancelled).toHaveBeenCalled();
    });
  });
});

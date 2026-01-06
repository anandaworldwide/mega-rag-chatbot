import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AddUsersModal } from "@/components/AddUsersModal";
import { SiteConfig } from "@/types/siteConfig";

// Mock fetch for profile API
global.fetch = jest.fn();

// Mock site config
const mockSiteConfig: SiteConfig = {
  siteId: "test",
  name: "Test Chatbot",
  shortname: "TestBot",
  tagline: "Explore, Discover, Learn",
  greeting: "Hi! How can I help you?",
  parent_site_url: "https://test.com",
  parent_site_name: "Test Site",
  help_url: "",
  help_text: "Help",
  collectionConfig: {},
  libraryMappings: {},
  enableSuggestedQueries: true,
  enableMediaTypeSelection: true,
  enableAuthorSelection: true,
  welcome_popup_heading: "Welcome",
  other_visitors_reference: "other visitors",
  loginImage: null,
  chatPlaceholder: "Send a message",
  header: { logo: "", navItems: [] },
  footer: { links: [] },
  requireLogin: false,
  allowTemporarySessions: false,
  allowAllAnswersPage: false,
  queriesPerUserPerDay: 100,
  showSourceContent: true,
  showVoting: true,
};

describe("AddUsersModal", () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onAddUsers: jest.fn(),
    isSubmitting: false,
    siteConfig: mockSiteConfig,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock profile API response with admin first name
    (global.fetch as jest.MockedFunction<typeof fetch>).mockResolvedValue({
      ok: true,
      json: async () => ({ firstName: "Michael" }),
    } as Response);
  });

  it("renders when open", () => {
    render(<AddUsersModal {...defaultProps} />);

    expect(screen.getByText("Add Users")).toBeInTheDocument();
    expect(screen.getByLabelText("Email Addresses")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<AddUsersModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText("Add Users")).not.toBeInTheDocument();
  });

  it("disables submit button for empty input", () => {
    render(<AddUsersModal {...defaultProps} />);

    const submitButton = screen.getByRole("button", { name: /add 0 users/i });
    expect(submitButton).toBeDisabled();

    expect(defaultProps.onAddUsers).not.toHaveBeenCalled();
  });

  it("disables submit button for invalid emails", () => {
    render(<AddUsersModal {...defaultProps} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "invalid-email, another-invalid" } });

    const submitButton = screen.getByRole("button", { name: /add 0 users/i });
    expect(submitButton).toBeDisabled();

    expect(defaultProps.onAddUsers).not.toHaveBeenCalled();
  });

  it("shows validation error for mixed valid and invalid emails", async () => {
    render(<AddUsersModal {...defaultProps} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "valid@example.com, invalid-email" } });

    const submitButton = screen.getByRole("button", { name: /add 1 user/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Invalid email format: invalid-email")).toBeInTheDocument();
    });

    expect(defaultProps.onAddUsers).not.toHaveBeenCalled();
  });

  it("submits valid emails successfully", async () => {
    const mockOnAddUsers = jest.fn().mockResolvedValue(undefined);
    render(<AddUsersModal {...defaultProps} onAddUsers={mockOnAddUsers} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "user1@example.com, user2@example.com" } });

    const submitButton = screen.getByRole("button", { name: /add 2 users/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAddUsers).toHaveBeenCalledWith(
        ["user1@example.com", "user2@example.com"],
        expect.stringContaining("Please join us in using TestBot")
      );
    });

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("handles emails with names in angle brackets", async () => {
    const mockOnAddUsers = jest.fn().mockResolvedValue(undefined);
    render(<AddUsersModal {...defaultProps} onAddUsers={mockOnAddUsers} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "John Doe <john@example.com>\nJane Smith <jane@example.com>" } });

    const submitButton = screen.getByRole("button", { name: /add 2 users/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAddUsers).toHaveBeenCalledWith(
        ["john@example.com", "jane@example.com"],
        expect.stringContaining("Please join us in using TestBot")
      );
    });
  });

  it("shows live validation feedback", () => {
    render(<AddUsersModal {...defaultProps} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "user1@example.com, invalid-email, user2@example.com" } });

    // Just check that the button shows the correct count - this is the most important validation feedback
    expect(screen.getByRole("button", { name: /add 2 users/i })).toBeInTheDocument();

    // Check that there are colored spans indicating validation status
    const greenSpan = document.querySelector(".text-green-600");
    const redSpan = document.querySelector(".text-red-600");
    expect(greenSpan).toBeInTheDocument();
    expect(redSpan).toBeInTheDocument();
  });

  it("updates button text based on valid email count", () => {
    render(<AddUsersModal {...defaultProps} />);

    const textarea = screen.getByLabelText("Email Addresses");

    // No emails
    expect(screen.getByRole("button", { name: /add 0 users/i })).toBeInTheDocument();

    // One email
    fireEvent.change(textarea, { target: { value: "user@example.com" } });
    expect(screen.getByRole("button", { name: /add 1 user$/i })).toBeInTheDocument();

    // Multiple emails
    fireEvent.change(textarea, { target: { value: "user1@example.com, user2@example.com" } });
    expect(screen.getByRole("button", { name: /add 2 users/i })).toBeInTheDocument();
  });

  it("disables form when submitting", () => {
    render(<AddUsersModal {...defaultProps} isSubmitting={true} />);

    const textarea = screen.getByLabelText("Email Addresses");
    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    const submitButton = screen.getByRole("button", { name: /adding/i });

    expect(textarea).toBeDisabled();
    expect(cancelButton).toBeDisabled();
    expect(submitButton).toBeDisabled();
  });

  it("closes modal when cancel is clicked", () => {
    render(<AddUsersModal {...defaultProps} />);

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("clears form when modal closes successfully", async () => {
    const mockOnAddUsers = jest.fn().mockResolvedValue(undefined);
    render(<AddUsersModal {...defaultProps} onAddUsers={mockOnAddUsers} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "user@example.com" } });

    const submitButton = screen.getByRole("button", { name: /add 1 user/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAddUsers).toHaveBeenCalled();
    });

    // Modal should close and form should be cleared
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("does not close modal when there is an error", async () => {
    const mockOnAddUsers = jest.fn().mockRejectedValue(new Error("API Error"));
    render(<AddUsersModal {...defaultProps} onAddUsers={mockOnAddUsers} />);

    const textarea = screen.getByLabelText("Email Addresses");
    fireEvent.change(textarea, { target: { value: "user@example.com" } });

    const submitButton = screen.getByRole("button", { name: /add 1 user/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockOnAddUsers).toHaveBeenCalled();
    });

    // Modal should not close on error
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it("uses admin first name and site config in default custom message", async () => {
    // Clear localStorage to ensure we get the default message
    localStorage.clear();

    render(<AddUsersModal {...defaultProps} />);

    // Wait for the profile fetch and message update
    await waitFor(() => {
      const textarea = screen.getByLabelText("Custom Message (Optional)") as HTMLTextAreaElement;
      expect(textarea.value).toContain("Please join us in using TestBot to explore, discover, learn");
      expect(textarea.value).toContain("Aums,\nMichael");
    });
  });

  it("handles profile fetch failure gracefully", async () => {
    (global.fetch as jest.MockedFunction<typeof fetch>).mockRejectedValue(new Error("Network error"));

    render(<AddUsersModal {...defaultProps} />);

    // Should still show default message with "Admin" fallback
    await waitFor(() => {
      const textarea = screen.getByLabelText("Custom Message (Optional)") as HTMLTextAreaElement;
      expect(textarea.value).toContain("Please join us in using TestBot to explore, discover, learn");
      expect(textarea.value).toContain("Aums,\nAdmin");
    });
  });

  it("handles null siteConfig gracefully", async () => {
    render(<AddUsersModal {...defaultProps} siteConfig={null} />);

    await waitFor(() => {
      const textarea = screen.getByLabelText("Custom Message (Optional)") as HTMLTextAreaElement;
      // Should use fallback values when siteConfig is null
      expect(textarea.value).toContain(
        "Please join us in using our chatbot to explore and discover answers to your questions"
      );
      expect(textarea.value).toContain("Aums,\nMichael");
    });
  });

  it("shows error when more than 40 emails are entered", async () => {
    render(<AddUsersModal {...defaultProps} />);

    // Generate 41 email addresses
    const emails = Array.from({ length: 41 }, (_, i) => `user${i + 1}@example.com`).join(", ");

    const emailInput = screen.getByLabelText("Email Addresses");

    fireEvent.change(emailInput, { target: { value: emails } });

    // Wait for button text to update after email input change
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add 41 Users/i })).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: /Add 41 Users/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          /Too many email addresses. Please limit to 40 emails per invitation batch. You entered 41 emails./
        )
      ).toBeInTheDocument();
    });

    // Should not call onAddUsers
    expect(defaultProps.onAddUsers).not.toHaveBeenCalled();
  });

  it("allows exactly 40 emails", async () => {
    render(<AddUsersModal {...defaultProps} />);

    // Generate exactly 40 email addresses
    const emails = Array.from({ length: 40 }, (_, i) => `user${i + 1}@example.com`).join(", ");

    const emailInput = screen.getByLabelText("Email Addresses");

    fireEvent.change(emailInput, { target: { value: emails } });

    // Wait for button text to update after email input change
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add 40 Users/i })).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: /Add 40 Users/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(defaultProps.onAddUsers).toHaveBeenCalledWith(
        expect.arrayContaining(Array.from({ length: 40 }, (_, i) => `user${i + 1}@example.com`)),
        expect.stringContaining("Please join us in using TestBot")
      );
    });

    // Should not show any error
    expect(screen.queryByText(/Too many email addresses/)).not.toBeInTheDocument();
  });
});

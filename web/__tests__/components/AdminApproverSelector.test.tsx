import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminApproverSelector from "@/components/AdminApproverSelector";
import { fetchWithAuth } from "@/utils/client/tokenManager";

// Mock the tokenManager
jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
  getToken: jest.fn().mockResolvedValue("mock-token"),
  initializeTokenManager: jest.fn().mockResolvedValue("mock-token"),
  isAuthenticated: jest.fn().mockReturnValue(true),
}));

describe("AdminApproverSelector", () => {
  const mockApproversData = {
    lastUpdated: "2025-10-03",
    regions: [
      {
        name: "Americas",
        admins: [
          {
            name: "Admin User One",
            email: "admin1@example.com",
            location: "Test City, CA",
          },
          {
            name: "Admin User Two",
            email: "admin2@example.com",
            location: "Test Bay Area, CA",
          },
        ],
      },
      {
        name: "Europe",
        admins: [],
      },
      {
        name: "Asia-Pacific",
        admins: [
          {
            name: "Admin User Three",
            email: "admin3@example.com",
            location: "Test City, New Zealand",
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render loading state initially", () => {
    fetchWithAuth.mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    // Check for loading spinner
    const loadingSpinner = document.querySelector(".animate-spin");
    expect(loadingSpinner).toBeInTheDocument();
  });

  it("should fetch and display admin approvers", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => mockApproversData,
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox");
    expect(select).toBeInTheDocument();

    // Check that regions and admins are rendered
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1); // At least the default option + admin options
  });

  it("should group admins by region", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => mockApproversData,
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    // Check for optgroup labels
    const select = screen.getByRole("combobox");
    const optgroups = select.querySelectorAll("optgroup");

    // Should have 2 optgroups (Americas and Asia-Pacific, Europe has no admins)
    expect(optgroups.length).toBe(2);
    expect(optgroups[0]).toHaveAttribute("label", "Americas");
    expect(optgroups[1]).toHaveAttribute("label", "Asia-Pacific");
  });

  it("should handle admin selection", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => mockApproversData,
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox");

    // Select an admin
    fireEvent.change(select, {
      target: { value: "admin1@example.com|Admin User One|Test City, CA" },
    });

    await waitFor(() => {
      expect(screen.getByText(/your request will be sent to/i)).toBeInTheDocument();
      // Use getAllByText since the name appears in both the option and the confirmation message
      const adminElements = screen.getAllByText(/Admin User One/);
      expect(adminElements.length).toBeGreaterThan(0);
    });
  });

  it("should submit approval request successfully", async () => {
    fetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockApproversData,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: "Approval request submitted successfully", requestId: "req_123" }),
      });

    const onSuccess = jest.fn();

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox");
    fireEvent.change(select, {
      target: { value: "admin1@example.com|Admin User One|Test City, CA" },
    });

    const submitButton = screen.getByRole("button", { name: /request access/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });

    expect(fetchWithAuth).toHaveBeenCalledWith("/api/admin/requestApproval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requesterEmail: "test@example.com",
        requesterName: "Test User",
        adminEmail: "admin1@example.com",
        adminName: "Admin User One",
        adminLocation: "Test City, CA",
        referenceNote: undefined,
      }),
    });
  });

  it("should display error when submission fails", async () => {
    fetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockApproversData,
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Failed to submit request" }),
      });

    const onError = jest.fn();

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" onError={onError} />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox");
    fireEvent.change(select, {
      target: { value: "admin1@example.com|Admin User One|Test City, CA" },
    });

    const submitButton = screen.getByRole("button", { name: /request access/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/failed to submit request/i)).toBeInTheDocument();
      expect(onError).toHaveBeenCalledWith("Failed to submit request");
    });
  });

  it("should display error when fetching approvers fails", async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error("Network error"));

    const onError = jest.fn();

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" onError={onError} />);

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
      expect(onError).toHaveBeenCalledWith("Network error");
    });
  });

  it("should handle empty admin list", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        lastUpdated: "2025-10-03",
        regions: [
          { name: "Americas", admins: [] },
          { name: "Europe", admins: [] },
        ],
      }),
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByText(/no admin approvers are currently available/i)).toBeInTheDocument();
    });
  });

  it("should disable submit button when no admin selected", async () => {
    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => mockApproversData,
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: /request access/i });
    expect(submitButton).toBeDisabled();
  });

  it("should disable form while submitting", async () => {
    fetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockApproversData,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: async () => ({ message: "Success" }) }), 100);
          })
      );

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox");
    fireEvent.change(select, {
      target: { value: "admin1@example.com|Admin User One|Test City, CA" },
    });

    const submitButton = screen.getByRole("button", { name: /request access/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/submitting request/i)).toBeInTheDocument();
    });

    expect(select).toBeDisabled();
  });

  it("should show fallback Support admin when S3 file is missing", async () => {
    const fallbackData = {
      lastUpdated: "2025-10-04T12:00:00.000Z",
      regions: [
        {
          name: "General",
          admins: [
            {
              name: "Support",
              email: "support@ananda.org",
              location: "Global Support Team",
            },
          ],
        },
      ],
    };

    fetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => fallbackData,
    });

    render(<AdminApproverSelector requesterEmail="test@example.com" requesterName="Test User" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/select an admin to contact/i)).toBeInTheDocument();
    });

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    // Check that the Support option is available
    const options = Array.from(select.options);
    const supportOption = options.find((option) => option.value.includes("support@ananda.org"));
    expect(supportOption).toBeTruthy();
    expect(supportOption?.textContent).toBe("Support (Global Support Team)");
  });
});

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TitleScopePicker } from "@/components/TitleScopePicker";
import { TitleScopeSelection, TitleScopeSuggestion } from "@/types/titleScope";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import * as analyticsModule from "@/utils/client/analytics";

jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ suggestions: [], query: "" }),
  }),
}));

jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

describe("TitleScopePicker", () => {
  const originalInnerWidth = window.innerWidth;
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const mockFetchWithAuth = jest.mocked(fetchWithAuth);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1280,
    });
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof requestAnimationFrame;
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [], query: "" }),
    } as Awaited<ReturnType<typeof fetchWithAuth>>);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    global.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("autofocuses the input on desktop when opened", async () => {
    render(<TitleScopePicker value={null} onChange={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Focus on one source" }));
    jest.runAllTimers();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Lessons in Meditation, Bible Genesis, etc.")).toHaveFocus();
    });
  });

  it("moves focus from the input into the suggestion list with arrow keys", async () => {
    const suggestions: TitleScopeSuggestion[] = [
      {
        canonicalPrefix: "Lessons in Meditation",
        displayTitle: "Lessons in Meditation",
        depth: 1,
        fullTitleCount: 1,
        vectorCount: 12,
        matchType: "exact",
        score: 1,
      },
      {
        canonicalPrefix: "The Bible::Book of Matthew",
        displayTitle: "The Bible::Book of Matthew",
        depth: 2,
        fullTitleCount: 4,
        vectorCount: 30,
        matchType: "contains",
        score: 0.8,
      },
    ];

    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ suggestions, query: "Le" }),
    } as Awaited<ReturnType<typeof fetchWithAuth>>);

    render(<TitleScopePicker value={null} onChange={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Focus on one source" }));
    jest.runOnlyPendingTimers();

    const input = await screen.findByPlaceholderText("Lessons in Meditation, Bible Genesis, etc.");
    fireEvent.change(input, { target: { value: "Le" } });
    jest.runAllTimers();

    await waitFor(() => {
      expect(screen.getByText("Lessons in Meditation")).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(screen.getByText("Lessons in Meditation").closest("button")).toHaveFocus();
  });

  it("shows the active focused-source chip and clears it", () => {
    const Wrapper = () => {
      const [value, setValue] = React.useState<TitleScopeSelection | null>({
        canonicalPrefix: "The Bible::New Testament::Book of Matthew",
        displayTitle: "The Bible::New Testament::Book of Matthew",
        userInput: "The Bible::New Testament::Book of Matthew",
      });

      return <TitleScopePicker value={value} onChange={setValue} />;
    };

    render(<Wrapper />);

    expect(screen.getByText("Focused: The Bible > New Testament > Book of Matthew")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear focused source" }));

    expect(screen.queryByText("Focused: The Bible > New Testament > Book of Matthew")).not.toBeInTheDocument();
  });

  it("logs analytics when opening, selecting, and clearing a source focus", async () => {
    const mockLogEvent = jest.mocked(analyticsModule.logEvent);
    const suggestions: TitleScopeSuggestion[] = [
      {
        canonicalPrefix: "Lessons in Meditation",
        displayTitle: "Lessons in Meditation",
        depth: 1,
        fullTitleCount: 1,
        vectorCount: 12,
        matchType: "exact",
        score: 1,
      },
    ];

    mockFetchWithAuth.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ suggestions, query: "Le" }),
    } as Awaited<ReturnType<typeof fetchWithAuth>>);

    const Wrapper = () => {
      const [value, setValue] = React.useState<TitleScopeSelection | null>(null);
      return <TitleScopePicker value={value} onChange={setValue} />;
    };

    render(<Wrapper />);

    fireEvent.click(screen.getByRole("button", { name: "Focus on one source" }));
    expect(mockLogEvent).toHaveBeenCalledWith("source_focus_picker_opened", "Source Focus", "empty");

    const input = await screen.findByPlaceholderText("Lessons in Meditation, Bible Genesis, etc.");
    fireEvent.change(input, { target: { value: "Le" } });
    jest.runAllTimers();

    await waitFor(() => {
      expect(screen.getByText("Lessons in Meditation")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Lessons in Meditation"));
    expect(mockLogEvent).toHaveBeenCalledWith("source_focus_picker_selected", "Source Focus", "Lessons in Meditation");

    fireEvent.click(screen.getByRole("button", { name: "Clear focused source" }));
    expect(mockLogEvent).toHaveBeenCalledWith("source_focus_cleared", "Source Focus", "Lessons in Meditation");
  });
});

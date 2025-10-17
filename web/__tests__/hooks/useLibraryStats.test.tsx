import { renderHook, waitFor } from "@testing-library/react";
import { useLibraryStats } from "@/hooks/useLibraryStats";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import type { SiteConfig } from "@/types/siteConfig";

// Mock dependencies
jest.mock("@/utils/client/tokenManager", () => ({
  fetchWithAuth: jest.fn(),
}));

const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;

describe("useLibraryStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return null stats and loading=true initially", async () => {
    const mockSiteConfig = { siteId: "ananda" } as SiteConfig;

    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const { result } = renderHook(() => useLibraryStats(mockSiteConfig));

    expect(result.current.stats).toBeNull();
    expect(result.current.loading).toBe(true);

    // Wait for the fetch to complete
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
  });

  it("should not fetch stats when siteConfig is null", async () => {
    const { result } = renderHook(() => useLibraryStats(null));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toBeNull();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("should fetch and return stats successfully", async () => {
    const mockStats = {
      site: "ananda",
      libraries: {
        "Ananda Library": 1000,
        "Crystal Clarity": 2000,
      },
      mediaTypes: {
        text: 500,
        audio: 300,
        youtube: 200,
      },
      authors: {
        "Paramhansa Yogananda": 300,
        "Swami Kriyananda": 400,
      },
      calculatedAt: new Date("2024-01-01"),
      lastUpdated: new Date("2024-01-01"),
    };

    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStats),
    } as Response);

    const mockSiteConfig = { siteId: "ananda" } as SiteConfig;

    const { result } = renderHook(() => useLibraryStats(mockSiteConfig));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toEqual(mockStats);
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/libraryStats");
  });

  it("should handle empty stats gracefully", async () => {
    const emptyStats = {
      libraries: {},
      mediaTypes: {},
      authors: {},
    };

    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(emptyStats),
    } as Response);

    const mockSiteConfig = { siteId: "ananda" } as SiteConfig;

    const { result } = renderHook(() => useLibraryStats(mockSiteConfig));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toEqual(emptyStats);
  });

  it("should handle API errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    mockFetchWithAuth.mockRejectedValue(new Error("Network error"));

    const mockSiteConfig = { siteId: "ananda" } as SiteConfig;

    const { result } = renderHook(() => useLibraryStats(mockSiteConfig));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith("Failed to fetch library stats:", expect.any(Error));

    consoleErrorSpy.mockRestore();
  });

  it("should refetch when siteConfig changes", async () => {
    const mockStatsAnanda = {
      site: "ananda",
      libraries: { "Ananda Library": 1000 },
      mediaTypes: { text: 500 },
      authors: { "Paramhansa Yogananda": 300 },
    };

    const mockStatsCrystal = {
      site: "crystal",
      libraries: { "Crystal Clarity": 2000 },
      mediaTypes: { text: 800 },
      authors: { "Swami Kriyananda": 400 },
    };

    mockFetchWithAuth
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStatsAnanda),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockStatsCrystal),
      } as Response);

    const { result, rerender } = renderHook(({ config }) => useLibraryStats(config), {
      initialProps: { config: { siteId: "ananda" } as SiteConfig },
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats?.site).toBe("ananda");
    expect(result.current.stats?.libraries).toEqual({ "Ananda Library": 1000 });

    // Change site config
    rerender({ config: { siteId: "crystal" } as SiteConfig });

    await waitFor(() => {
      expect(result.current.stats?.site).toBe("crystal");
    });

    expect(result.current.stats?.libraries).toEqual({ "Crystal Clarity": 2000 });
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("should not refetch when siteConfig reference stays the same", async () => {
    const mockStats = {
      site: "ananda",
      libraries: { "Ananda Library": 1000 },
      mediaTypes: { text: 500 },
      authors: { "Paramhansa Yogananda": 300 },
    };

    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStats),
    } as Response);

    const sameConfig = { siteId: "ananda", name: "Ananda Site" } as SiteConfig;

    const { result, rerender } = renderHook(({ config }) => useLibraryStats(config), {
      initialProps: { config: sameConfig },
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    // Rerender with same object reference (production behavior - siteConfig is stable)
    rerender({ config: sameConfig });

    // Should not trigger another fetch since reference is the same
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("should handle JSON parsing errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("Invalid JSON")),
    } as Response);

    const mockSiteConfig = { siteId: "ananda" } as SiteConfig;

    const { result } = renderHook(() => useLibraryStats(mockSiteConfig));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.stats).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

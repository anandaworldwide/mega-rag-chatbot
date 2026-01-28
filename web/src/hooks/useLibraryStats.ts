import { useState, useEffect } from "react";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import type { SiteConfig } from "@/types/siteConfig";
import type { LibraryStats } from "@/types/LibraryStats";

export function useLibraryStats(siteConfig: SiteConfig | null) {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!siteConfig) {
      setLoading(false);
      return;
    }

    fetchWithAuth("/api/libraryStats")
      .then((res) => res.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch library stats:", err);
        setStats(null);
        setLoading(false);
      });
  }, [siteConfig]);

  return { stats, loading };
}

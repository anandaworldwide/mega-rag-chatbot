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
    // siteConfig is static at runtime (set at build time via SITE env var), but we need
    // this effect to run when siteConfig becomes available. Including siteConfig in deps
    // to trigger on mount when it goes from null -> defined.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteConfig]);

  return { stats, loading };
}

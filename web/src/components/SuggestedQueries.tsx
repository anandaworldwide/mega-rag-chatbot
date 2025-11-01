import React, { useState, useMemo } from "react";
import { logEvent } from "@/utils/client/analytics";
import { SiteConfig } from "@/types/siteConfig";
import { CategorizedQueries } from "@/utils/client/categorizedQueries";

interface SuggestedQueriesProps {
  queries: string[];
  onQueryClick: (query: string) => void;
  isLoading: boolean;
  shuffleQueries: () => void;
  isMobile: boolean;
  siteConfig: SiteConfig | null;
  onRefreshFunctionReady?: (refreshFn: () => void) => void;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
  categorizedQueries?: CategorizedQueries | null;
}

type CategoryType = "general" | "location" | "resources";

// Simple deterministic shuffle using a seed
const seededShuffle = <T,>(array: T[], seed: number): T[] => {
  const shuffled = [...array];
  let value = seed;
  const random = () => {
    value = (value * 9301 + 49297) % 233280;
    return value / 233280;
  };

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const SuggestedQueries: React.FC<SuggestedQueriesProps> = ({
  queries,
  onQueryClick,
  isLoading,
  shuffleQueries,
  isMobile,
  siteConfig: _siteConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
  categorizedQueries,
}) => {
  const [shuffleKey, setShuffleKey] = useState(0);

  // Get three examples for display
  const displayExamples = useMemo(() => {
    if (!categorizedQueries) {
      // Fallback to flat list - take 3
      const shuffled = seededShuffle([...queries], shuffleKey + 100);
      return shuffled.slice(0, 3).map((q, i) => ({ query: q, category: null as CategoryType | null, index: i }));
    }

    const examples: { query: string; category: CategoryType; index: number }[] = [];
    let index = 0;

    // Get one from each category that has queries
    if (categorizedQueries.general.length > 0) {
      const shuffled = seededShuffle([...categorizedQueries.general], shuffleKey + 1);
      examples.push({ query: shuffled[0], category: "general", index: index++ });
    }
    if (categorizedQueries.location.length > 0) {
      const shuffled = seededShuffle([...categorizedQueries.location], shuffleKey + 2);
      examples.push({ query: shuffled[0], category: "location", index: index++ });
    }
    if (categorizedQueries.resources.length > 0) {
      const shuffled = seededShuffle([...categorizedQueries.resources], shuffleKey + 3);
      examples.push({ query: shuffled[0], category: "resources", index: index++ });
    }

    // If we don't have 3 yet, fill from other categories
    if (examples.length < 3) {
      const allAvailable: { query: string; category: CategoryType }[] = [];
      if (categorizedQueries.general.length > 0) {
        allAvailable.push(
          ...categorizedQueries.general.map((q) => ({ query: q, category: "general" as CategoryType }))
        );
      }
      if (categorizedQueries.location.length > 0) {
        allAvailable.push(
          ...categorizedQueries.location.map((q) => ({ query: q, category: "location" as CategoryType }))
        );
      }
      if (categorizedQueries.resources.length > 0) {
        allAvailable.push(
          ...categorizedQueries.resources.map((q) => ({ query: q, category: "resources" as CategoryType }))
        );
      }

      const shuffled = seededShuffle(
        allAvailable.map((item) => item.query),
        shuffleKey + 200
      );

      // Add remaining queries to reach 3 total
      for (let i = 0; i < shuffled.length && examples.length < 3; i++) {
        const query = shuffled[i];
        // Skip if already in examples
        if (!examples.some((ex) => ex.query === query)) {
          const category = allAvailable.find((item) => item.query === query)?.category || "general";
          examples.push({ query, category, index: index++ });
        }
      }
    }

    // Randomize the order of examples
    const shuffledExamples = seededShuffle(examples, shuffleKey + 300);
    // Update indices to reflect new positions after shuffling
    return shuffledExamples.slice(0, 3).map((example, i) => ({ ...example, index: i }));
  }, [categorizedQueries, queries, shuffleKey]);

  // Handle regenerate/shuffle button click
  const handleRegenerate = () => {
    setShuffleKey((prev) => prev + 1);
    if (!categorizedQueries) {
      shuffleQueries();
    }

    const categoryInfo = categorizedQueries ? `categorized_queries` : `categorized_false`;

    logEvent("regenerate_suggested_queries", "Suggestions", `${categoryInfo}|mobile_${isMobile}`, 0);
  };

  const handleQueryClick = (query: string, category: CategoryType | null, index: number) => {
    if (!isLoading && query) {
      onQueryClick(query);

      // Randomize all three queries when user clicks one
      setShuffleKey((prev) => prev + 1);

      const categoryInfo = category ? `category_${category}` : `category_none`;

      logEvent(
        "select_suggested_query",
        "Suggestions",
        `${categoryInfo}|mobile_${isMobile}|example_${index + 1}`,
        index
      );
    }
  };

  // Don't render if no queries available
  const hasQueries = categorizedQueries
    ? categorizedQueries.general.length > 0 ||
      categorizedQueries.location.length > 0 ||
      categorizedQueries.resources.length > 0
    : queries.length > 0;

  if (!hasQueries) {
    return null;
  }

  return (
    <div className="text-left w-full px-0">
      <div className="bg-gray-50 p-3 rounded-xl w-full border border-gray-200">
        {/* Query buttons and regenerate button on same row */}
        <div className="flex items-center gap-2">
          {/* Three query buttons - using grid for responsive width */}
          {displayExamples.length > 0 && (
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
              {displayExamples.map((example, idx) => (
                <button
                  key={idx}
                  onClick={() => handleQueryClick(example.query, example.category, idx)}
                  className={`text-left px-3 py-2 text-sm rounded-xl transition-colors ${
                    isLoading
                      ? "bg-gray-100 border border-gray-200 text-gray-400 cursor-not-allowed"
                      : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  }`}
                  disabled={isLoading}
                >
                  {example.query}
                </button>
              ))}
            </div>
          )}
          {/* Regenerate button - aligned to the right */}
          <button
            onClick={handleRegenerate}
            className={`inline-flex justify-center items-center transform transition-transform duration-500 flex-shrink-0 ${
              isLoading ? "cursor-not-allowed opacity-50" : "hover:rotate-180"
            }`}
            aria-label="Generate new questions"
            disabled={isLoading}
            title="Get new example questions"
          >
            <span className={`material-icons ${isLoading ? "text-gray-400" : "text-gray-500 hover:text-gray-700"}`}>
              autorenew
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default SuggestedQueries;

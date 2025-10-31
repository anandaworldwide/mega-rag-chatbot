import React, { useState, useEffect, useMemo } from "react";
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

const SuggestedQueries: React.FC<SuggestedQueriesProps> = ({
  queries,
  onQueryClick,
  isLoading,
  shuffleQueries,
  isMobile,
  siteConfig, // eslint-disable-line @typescript-eslint/no-unused-vars
  onRefreshFunctionReady, // eslint-disable-line @typescript-eslint/no-unused-vars
  isExpanded = true,
  onToggleExpanded,
  categorizedQueries,
}) => {
  const [currentQueryIndex, setCurrentQueryIndex] = useState(0);
  const [shuffleKey, setShuffleKey] = useState(0); // Force re-shuffle when changed

  // Track current category and available categories for rotation
  const getAvailableCategories = (): CategoryType[] => {
    if (!categorizedQueries) return [];
    const available: CategoryType[] = [];
    if (categorizedQueries.general.length > 0) available.push("general");
    if (categorizedQueries.location.length > 0) available.push("location");
    if (categorizedQueries.resources.length > 0) available.push("resources");
    return available;
  };

  const availableCategories = getAvailableCategories();

  // Initialize current category randomly
  const [currentCategory, setCurrentCategory] = useState<CategoryType | null>(() => {
    if (!categorizedQueries) return null;
    const available: CategoryType[] = [];
    if (categorizedQueries.general.length > 0) available.push("general");
    if (categorizedQueries.location.length > 0) available.push("location");
    if (categorizedQueries.resources.length > 0) available.push("resources");
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  });

  // Update category when categorizedQueries changes
  useEffect(() => {
    if (categorizedQueries && availableCategories.length > 0) {
      // If current category is no longer available, pick a new one
      if (!currentCategory || !availableCategories.includes(currentCategory)) {
        setCurrentCategory(availableCategories[Math.floor(Math.random() * availableCategories.length)]);
      }
    } else if (!categorizedQueries) {
      setCurrentCategory(null);
    }
  }, [categorizedQueries, availableCategories, currentCategory]);

  // Rotate to a different category (not the one just shown)
  const rotateToDifferentCategory = (currentCat: CategoryType | null): CategoryType | null => {
    if (availableCategories.length <= 1) return currentCat;

    // Get all categories except the current one
    const otherCategories = availableCategories.filter((cat) => cat !== currentCat);

    // Pick randomly from the other categories
    if (otherCategories.length > 0) {
      return otherCategories[Math.floor(Math.random() * otherCategories.length)];
    }

    // Fallback: if somehow all are the same, just rotate to next
    const currentIndex = availableCategories.indexOf(currentCat || availableCategories[0]);
    return availableCategories[(currentIndex + 1) % availableCategories.length];
  };

  // Simple deterministic shuffle using a seed
  // Same seed + same array = same result every time
  const seededShuffle = (array: string[], seed: number): string[] => {
    const shuffled = [...array];
    // Use a simple seeded random number generator
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

  // Determine how many queries to show per category
  const queriesPerCategory = isMobile ? 1 : 2;

  // Memoize selected queries for the current category to prevent re-shuffling on every render
  const selectedQueries = useMemo(() => {
    if (!categorizedQueries || !currentCategory) return [];

    let categoryQueries: string[] = [];
    if (currentCategory === "general") {
      categoryQueries = categorizedQueries.general;
    } else if (currentCategory === "location") {
      categoryQueries = categorizedQueries.location;
    } else if (currentCategory === "resources") {
      categoryQueries = categorizedQueries.resources;
    }

    if (categoryQueries.length === 0) return [];

    // Create a deterministic seed from shuffleKey and currentCategory
    const seed = shuffleKey * 1000 + (currentCategory === "general" ? 1 : currentCategory === "location" ? 2 : 3);
    const shuffled = seededShuffle(categoryQueries, seed);
    return shuffled.slice(0, queriesPerCategory);
  }, [categorizedQueries, currentCategory, shuffleKey, queriesPerCategory]);

  // Handle regenerate/shuffle button click
  const handleRegenerate = () => {
    if (categorizedQueries) {
      // Force re-shuffle by incrementing shuffleKey and rotating category
      setShuffleKey((prev) => prev + 1);
      setCurrentCategory((prev) => rotateToDifferentCategory(prev));
    } else {
      // Fall back to flat list shuffle
      shuffleQueries();
    }

    const categoryInfo = categorizedQueries && currentCategory ? `category_${currentCategory}` : `categorized_false`;

    logEvent(
      "regenerate_suggested_queries",
      "Suggestions",
      `${categoryInfo}|mobile_${isMobile}|expanded_${isExpanded}`,
      0
    );
  };

  const handleQueryClick = (query: string, categoryLabel?: string) => {
    if (!isLoading && query) {
      onQueryClick(query);
      setCurrentQueryIndex((prevIndex) => (prevIndex + 1) % queries.length);

      // Rotate to a different category after clicking
      if (categorizedQueries && categoryLabel) {
        const clickedCategory = categoryLabel as CategoryType;
        setCurrentCategory(rotateToDifferentCategory(clickedCategory));
        setShuffleKey((prev) => prev + 1); // Re-shuffle for next display
      }

      // Format category prominently at the start of the label for easier parsing in GA
      const categoryInfo = categoryLabel
        ? `category_${categoryLabel}`
        : categorizedQueries
          ? `category_unknown`
          : `category_none`;

      logEvent(
        "select_suggested_query",
        "Suggestions",
        `${categoryInfo}|mobile_${isMobile}|expanded_${isExpanded}|query_index_${currentQueryIndex}`,
        currentQueryIndex
      );
    }
  };

  const handleShuffleQueries = (e: React.MouseEvent) => {
    e.preventDefault();
    shuffleQueries();

    logEvent(
      "randomize_suggested_queries",
      "Suggestions",
      `shuffle_clicked|index_${currentQueryIndex}|total_${queries.length}|mobile_${isMobile}|expanded_${isExpanded}`,
      currentQueryIndex
    );
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
      <div className="bg-gray-50 p-3 rounded-xl w-full border border-gray-200 mt-4">
        {/* Header */}
        <div className="flex justify-between items-start mb-2">
          <div className="flex-1">
            <h3 className="font-semibold text-gray-600 text-base mb-1">Ask me anything about Ananda teachings</h3>
            <p className="text-sm text-gray-500">
              You can ask spiritual questions, explore resources, or find locations. Try these examples:
            </p>
          </div>
          <div className="flex items-center space-x-2 ml-2">
            {/* Regenerate/Shuffle button - always visible */}
            <button
              onClick={handleRegenerate}
              className="inline-flex justify-center items-center transform transition-transform duration-500 hover:rotate-180 flex-shrink-0"
              aria-label="Generate new questions"
              disabled={isLoading}
              title="Get new example questions"
            >
              <span className="material-icons text-gray-500 hover:text-gray-700">autorenew</span>
            </button>
            {/* Expand/Collapse button */}
            {onToggleExpanded && (
              <button
                onClick={() => {
                  const action = isExpanded ? "minimize" : "expand";
                  onToggleExpanded();

                  const queryCount = categorizedQueries
                    ? categorizedQueries.general.length +
                      categorizedQueries.location.length +
                      categorizedQueries.resources.length
                    : queries.length;

                  const categoryInfo =
                    categorizedQueries && currentCategory
                      ? `category_${currentCategory}|categorized_queries`
                      : `categorized_false`;

                  logEvent(
                    `${action}_suggestions`,
                    "Suggestions",
                    `${categoryInfo}|from_${isExpanded ? "expanded" : "minimized"}|mobile_${isMobile}`,
                    queryCount
                  );
                }}
                className="inline-flex justify-center items-center flex-shrink-0"
                aria-label={isExpanded ? "Minimize suggestions" : "Expand suggestions"}
              >
                <span className="material-icons text-gray-600 hover:text-gray-800">
                  {isExpanded ? "keyboard_arrow_up" : "expand_more"}
                </span>
              </button>
            )}
          </div>
        </div>

        {isExpanded && (
          <>
            {/* Category sections if using categorized queries */}
            {categorizedQueries && currentCategory ? (
              <div className="mt-4">
                {/* Render only the current category */}
                {currentCategory === "location" && categorizedQueries.location.length > 0 && (
                  <div>
                    <div className="flex items-center mb-2">
                      <span className="material-icons text-gray-500 text-sm mr-1">location_on</span>
                      <h4 className="font-medium text-sm text-gray-600">Find Centers Near You</h4>
                    </div>
                    <p className="text-xs text-gray-600 mb-2">
                      I can help you find Ananda centers and meditation groups in your area.
                    </p>
                    <div className="space-y-2" key={`location-${shuffleKey}`}>
                      {selectedQueries.map((query, index) => (
                        <button
                          key={index}
                          onClick={() => handleQueryClick(query, "location")}
                          className="w-full text-left px-3 py-2 bg-white border border-gray-200 text-gray-700 text-sm rounded-xl hover:bg-gray-50 hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                          disabled={isLoading}
                        >
                          {query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {currentCategory === "resources" && categorizedQueries.resources.length > 0 && (
                  <div>
                    <div className="flex items-center mb-2">
                      <span className="material-icons text-gray-500 text-sm mr-1">folder</span>
                      <h4 className="font-medium text-sm text-gray-600">Discover Ananda Resources</h4>
                    </div>
                    <p className="text-xs text-gray-600 mb-2">
                      Learn about Ananda&apos;s digital resources and online communities.
                    </p>
                    <div className="space-y-2" key={`resources-${shuffleKey}`}>
                      {selectedQueries.map((query, index) => (
                        <button
                          key={index}
                          onClick={() => handleQueryClick(query, "resources")}
                          className="w-full text-left px-3 py-2 bg-white border border-gray-200 text-gray-700 text-sm rounded-xl hover:bg-gray-50 hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                          disabled={isLoading}
                        >
                          {query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {currentCategory === "general" && categorizedQueries.general.length > 0 && (
                  <div>
                    <div className="flex items-center mb-2">
                      <span className="material-icons text-gray-500 text-sm mr-1">chat</span>
                      <h4 className="font-medium text-sm text-gray-600">Spiritual Questions</h4>
                    </div>
                    <p className="text-xs text-gray-600 mb-2">
                      Ask about meditation, teachings, practices, or any spiritual topic.
                    </p>
                    <div className="space-y-2" key={`general-${shuffleKey}`}>
                      {selectedQueries.map((query, index) => (
                        <button
                          key={index}
                          onClick={() => handleQueryClick(query, "general")}
                          className="w-full text-left px-3 py-2 bg-white border border-gray-200 text-gray-700 text-sm rounded-xl hover:bg-gray-50 hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                          disabled={isLoading}
                        >
                          {query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : categorizedQueries ? null : (
              /* Fallback to flat list display */
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm text-gray-600">Example questions:</p>
                  <button
                    onClick={handleShuffleQueries}
                    className="inline-flex justify-center items-center transform transition-transform duration-500 hover:rotate-180 flex-shrink-0"
                    aria-label="Refresh queries"
                    disabled={isLoading}
                  >
                    <span className="material-icons text-blue-600 hover:text-blue-800 text-sm">autorenew</span>
                  </button>
                </div>
                {isMobile ? (
                  <div className="flex items-center">
                    <button
                      className={`flex-grow text-left break-words px-3 py-2 bg-white border border-gray-200 rounded-xl ${
                        isLoading
                          ? "text-gray-400 cursor-not-allowed"
                          : "text-blue-600 hover:text-blue-800 hover:border-blue-300"
                      }`}
                      onClick={() => handleQueryClick(queries[currentQueryIndex])}
                      disabled={isLoading}
                    >
                      {queries[currentQueryIndex]}
                    </button>
                  </div>
                ) : (
                  <ul className="list-none w-full space-y-2">
                    {queries.slice(0, 3).map((query, index) => (
                      <li key={index}>
                        <button
                          className={`w-full text-left px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm ${
                            isLoading
                              ? "text-gray-400 cursor-not-allowed"
                              : "text-blue-600 hover:text-blue-800 hover:border-blue-300"
                          } focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors`}
                          onClick={() => handleQueryClick(query)}
                          aria-label={`Sample query: ${query}`}
                          disabled={isLoading}
                        >
                          {query}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SuggestedQueries;

/**
 * Utilities for loading and managing categorized suggested queries
 */

export interface CategorizedQueries {
  general: string[];
  location: string[];
  resources: string[];
}

const cachedCategorizedQueries: Record<string, CategorizedQueries | null> = {};

/**
 * Parses a query file with category headers into categorized queries
 * Format:
 * # GENERAL
 * Query 1
 * Query 2
 *
 * # LOCATION
 * Query 3
 * Query 4
 *
 * # RESOURCES
 * Query 5
 * Query 6
 */
function parseCategorizedQueries(text: string): CategorizedQueries {
  const categories: CategorizedQueries = {
    general: [],
    location: [],
    resources: [],
  };

  let currentCategory: keyof CategorizedQueries | null = null;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines
    if (trimmedLine === "") {
      continue;
    }

    // Check for category headers (case-insensitive)
    if (trimmedLine.startsWith("#")) {
      const categoryName = trimmedLine.substring(1).trim().toUpperCase();
      if (categoryName === "GENERAL") {
        currentCategory = "general";
      } else if (categoryName === "LOCATION") {
        currentCategory = "location";
      } else if (categoryName === "RESOURCES") {
        currentCategory = "resources";
      } else {
        currentCategory = null;
      }
      continue;
    }

    // Add query to current category if we have one
    if (currentCategory) {
      categories[currentCategory].push(trimmedLine);
    }
  }

  return categories;
}

/**
 * Loads categorized queries for a site and collection
 * Falls back to flat list parsing if no categories found
 */
export async function loadCategorizedQueries(siteId: string, collection: string): Promise<CategorizedQueries | null> {
  const cacheKey = `${siteId}_${collection}`;

  // Check cache first
  if (cachedCategorizedQueries[cacheKey]) {
    return cachedCategorizedQueries[cacheKey];
  }

  try {
    const response = await fetch(`/data/${siteId}/${collection}_queries.txt`);

    if (!response.ok) {
      cachedCategorizedQueries[cacheKey] = null;
      return null;
    }

    const text = await response.text();
    const categories = parseCategorizedQueries(text);

    // Only cache if we found at least one category with queries
    if (categories.general.length > 0 || categories.location.length > 0 || categories.resources.length > 0) {
      cachedCategorizedQueries[cacheKey] = categories;
      return categories;
    }

    // No categories found - return null to fall back to flat list
    cachedCategorizedQueries[cacheKey] = null;
    return null;
  } catch (error) {
    console.error(`Error loading categorized queries for ${siteId}/${collection}:`, error);
    cachedCategorizedQueries[cacheKey] = null;
    return null;
  }
}

/**
 * Selects queries from each category based on mobile/desktop display count
 * Mobile: 1 from each category (3 total)
 * Desktop: 2-3 from each category (6-9 total)
 */
export function selectQueriesFromCategories(
  categories: CategorizedQueries,
  isMobile: boolean,
  isExpanded: boolean = true
): string[] {
  const selected: string[] = [];

  if (!isExpanded) {
    // When collapsed, just show 1-2 general queries
    const shuffledGeneral = [...categories.general].sort(() => 0.5 - Math.random());
    return shuffledGeneral.slice(0, isMobile ? 1 : 2);
  }

  const perCategory = isMobile ? 1 : 2; // Desktop can show more, but start with 2

  // Shuffle each category and take the requested number
  const shuffledGeneral = [...categories.general].sort(() => 0.5 - Math.random());
  const shuffledLocation = [...categories.location].sort(() => 0.5 - Math.random());
  const shuffledResources = [...categories.resources].sort(() => 0.5 - Math.random());

  // Add from each category that has queries
  if (categories.general.length > 0) {
    selected.push(...shuffledGeneral.slice(0, perCategory));
  }
  if (categories.location.length > 0) {
    selected.push(...shuffledLocation.slice(0, perCategory));
  }
  if (categories.resources.length > 0) {
    selected.push(...shuffledResources.slice(0, perCategory));
  }

  // Shuffle the final selection so categories are mixed
  return selected.sort(() => 0.5 - Math.random());
}

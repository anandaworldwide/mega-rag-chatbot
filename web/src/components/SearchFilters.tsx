import React, { useMemo } from "react";
import { SearchFilters as SearchFiltersType, SearchFacets } from "@/types/SearchTypes";
import { libraryMappings, getMappedLibraryName } from "@/utils/client/libraryMappings";

interface SearchFiltersProps {
  filters: SearchFiltersType;
  facets: SearchFacets;
  onFiltersChange: (filters: SearchFiltersType) => void;
  loading?: boolean;
  isMobile?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  allLibraries?: string[]; // Full library list from site config (supports zero-count display)
}

export default function SearchFilters({
  filters,
  facets,
  onFiltersChange,
  loading = false,
  isMobile = false,
  isOpen = false,
  onToggle,
  allLibraries,
}: SearchFiltersProps) {
  const handleTitleChange = (title: string) => {
    onFiltersChange({
      ...filters,
      title: filters.title === title ? undefined : title,
    });
  };

  const handleAuthorChange = (author: string) => {
    onFiltersChange({
      ...filters,
      author: filters.author === author ? undefined : author,
    });
  };

  const handleTypeChange = (type: "text" | "audio" | "youtube") => {
    const currentTypes = filters.type || [];
    const newTypes = currentTypes.includes(type) ? currentTypes.filter((t) => t !== type) : [...currentTypes, type];

    onFiltersChange({
      ...filters,
      type: newTypes.length > 0 ? newTypes : undefined,
    });
  };

  const handleLibraryChange = (library: string) => {
    const currentLibraries = filters.library || [];
    const next = currentLibraries.includes(library)
      ? currentLibraries.filter((l) => l !== library)
      : [...currentLibraries, library];
    onFiltersChange({
      ...filters,
      library: next.length > 0 ? next : undefined,
    });
  };

  const clearFilters = () => {
    onFiltersChange({});
  };

  const hasActiveFilters = Boolean(filters.title || filters.author || filters.type?.length || filters.library);

  const mergedTypes = useMemo(() => {
    const DEFAULT_TYPES: Array<"text" | "audio" | "youtube"> = ["text", "audio", "youtube"];
    return DEFAULT_TYPES.map((name) => {
      const facet = facets.types.find((t) => t.name === name);
      return { name, count: facet?.count ?? 0 };
    });
  }, [facets.types]);

  const mergedLibraries = useMemo(() => {
    const base = new Set<string>();
    (allLibraries || []).forEach((lib) => base.add(lib));
    Object.keys(libraryMappings).forEach((lib) => base.add(lib));
    facets.libraries.forEach((lib) => base.add(lib.name));
    if (filters.library) filters.library.forEach((lib) => base.add(lib));

    return Array.from(base).map((name) => {
      const facet = facets.libraries.find((l) => l.name === name);
      return { name, count: facet?.count ?? 0, display: getMappedLibraryName(name) };
    });
  }, [allLibraries, facets.libraries, filters.library]);

  const content = (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Filters</h3>
        {hasActiveFilters && (
          <button onClick={clearFilters} className="text-sm text-blue-600 hover:text-blue-700">
            Clear all
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 leading-snug">
        Counts reflect the current results window. Applying a filter runs a new search and may return more matches for
        that filter.
      </p>

      {/* Title filter */}
      {facets.titles.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Title ({facets.titles.length})</h4>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {facets.titles.map((title) => (
              <label key={title.name} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
                <input
                  type="checkbox"
                  checked={filters.title === title.name}
                  onChange={() => handleTitleChange(title.name)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                />
                <span className="text-sm text-gray-700 flex-1 break-words">{title.name}</span>
                <span className="text-xs text-gray-500 flex-shrink-0">({title.count})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Author filter */}
      {facets.authors.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-700 mb-2">Author</h4>
          <div className="space-y-1">
            {facets.authors.map((author) => (
              <label key={author.name} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
                <input
                  type="checkbox"
                  checked={filters.author === author.name}
                  onChange={() => handleAuthorChange(author.name)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 flex-1">{author.name}</span>
                <span className="text-xs text-gray-500">({author.count})</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Type filter */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Type</h4>
        <div className="space-y-1">
          {mergedTypes.map((type) => (
            <label key={type.name} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
              <input
                type="checkbox"
                checked={filters.type?.includes(type.name) || false}
                onChange={() => handleTypeChange(type.name)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700 flex-1 capitalize">{type.name}</span>
              <span className="text-xs text-gray-500">({type.count})</span>
            </label>
          ))}
        </div>
      </div>

      {/* Library filter */}
      <div>
        <h4 className="text-sm font-medium text-gray-700 mb-2">Library</h4>
        <div className="space-y-1">
          {mergedLibraries.map((library) => (
            <label key={library.name} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-1 rounded">
              <input
                type="checkbox"
                checked={filters.library?.includes(library.name) || false}
                onChange={() => handleLibraryChange(library.name)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700 flex-1">{library.display}</span>
              <span className="text-xs text-gray-500">({library.count})</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        <button onClick={onToggle} className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg mb-4 w-full">
          <span className="material-icons">{isOpen ? "expand_less" : "expand_more"}</span>
          <span className="font-medium">Filters</span>
          {loading && <span className="material-icons text-blue-600 animate-spin text-sm ml-1">refresh</span>}
          {hasActiveFilters && (
            <span className="ml-auto bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">
              {[filters.title, filters.author, filters.library, filters.type?.length].filter(Boolean).length}
            </span>
          )}
        </button>
        {isOpen && <div className="mb-4 relative">{content}</div>}
      </>
    );
  }

  return <div className="bg-white p-4 rounded-lg border border-gray-200 relative min-h-[120px]">{content}</div>;
}

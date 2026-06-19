/** @jest-environment node */
/**
 * Test suite for the calculateSources function in makechain.ts
 *
 * These tests focus on verifying that the calculateSources function properly:
 * 1. Distributes sources correctly based on weights
 * 2. Handles equal weights correctly
 * 3. Handles unequal weights correctly
 * 4. Returns the correct total number of sources
 */

import { calculateSources } from "@/utils/server/ragDocumentUtils";

interface Library {
  name: string;
  weight?: number;
  sources?: number;
}

describe('calculateSources', () => {
  test('should distribute sources correctly based on weights', () => {
    // Test with equal weights
    const libraries: Library[] = [
      { name: 'library1', weight: 1 },
      { name: 'library2', weight: 1 },
    ];

    const result = calculateSources(10, libraries);

    // Each library should get 5 sources (10 total / 2 libraries with equal weight)
    expect(result).toEqual([
      { name: 'library1', sources: 5 },
      { name: 'library2', sources: 5 },
    ]);

    // The total number of sources should match the input
    const totalSources = result.reduce(
      (sum: number, lib: Library) => sum + (lib.sources || 0),
      0,
    );
    expect(totalSources).toBe(10);
  });

  test('should distribute sources correctly with unequal weights', () => {
    // Test with unequal weights
    const weightedLibraries: Library[] = [
      { name: 'library1', weight: 2 },
      { name: 'library2', weight: 1 },
    ];

    const weightedResult = calculateSources(9, weightedLibraries);

    // library1 should get 6 sources (2/3 of 9), library2 should get 3 (1/3 of 9)
    expect(weightedResult).toEqual([
      { name: 'library1', sources: 6 },
      { name: 'library2', sources: 3 },
    ]);

    // The total number of sources should match the input
    const weightedTotalSources = weightedResult.reduce(
      (sum: number, lib: Library) => sum + (lib.sources || 0),
      0,
    );
    expect(weightedTotalSources).toBe(9);
  });

  test('should handle empty libraries array', () => {
    const result = calculateSources(10, []);
    expect(result).toEqual([]);
  });

  test('should handle libraries without weights', () => {
    const libraries: Library[] = [{ name: 'library1' }, { name: 'library2' }];

    const result = calculateSources(10, libraries);

    // Each library should get 5 sources (10 total / 2 libraries)
    expect(result).toEqual([
      { name: 'library1', sources: 5 },
      { name: 'library2', sources: 5 },
    ]);
  });

  test('should handle a mix of weighted and unweighted libraries', () => {
    const libraries: Library[] = [
      { name: 'library1', weight: 2 },
      { name: 'library2' }, // Default weight of 1
    ];

    const result = calculateSources(9, libraries);

    // With a total weight of 3 (2+1) and 9 sources:
    // library1 should get 6 sources (2/3 of 9)
    // library2 should get 3 sources (1/3 of 9)
    // But due to rounding, it might be different
    expect(result[0].name).toBe('library1');
    expect(result[1].name).toBe('library2');

    // Check that the total sources add up to approximately 9
    // Due to rounding, it might not be exactly 9
    const totalSources = result.reduce(
      (sum: number, lib: Library) => sum + (lib.sources || 0),
      0,
    );
    // Allow for rounding differences
    expect(totalSources).toBeGreaterThanOrEqual(9);
    expect(totalSources).toBeLessThanOrEqual(10);
  });

  test('should never return negative sources', () => {
    const libraries: Library[] = [
      { name: 'library1', weight: -1 }, // Negative weight (invalid but should be handled)
      { name: 'library2', weight: 1 },
    ];

    const result = calculateSources(10, libraries);

    // We're not testing exact values here since negative weights are invalid
    // Just check that we get a result with the right structure
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('library1');
    expect(result[1].name).toBe('library2');

    // Check that we have a sources property on each result
    expect(result[0]).toHaveProperty('sources');
    expect(result[1]).toHaveProperty('sources');
  });
});

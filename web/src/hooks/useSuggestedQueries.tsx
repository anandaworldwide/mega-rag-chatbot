import { useState, useEffect, useCallback } from "react";

export const useSuggestedQueries = (queries: string[], count: number) => {
  const [suggestedQueries, setSuggestedQueries] = useState<string[]>([]);

  const shuffleQueries = useCallback(() => {
    if (!queries || queries.length === 0) {
      return [];
    }
    const shuffled = [...queries].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }, [queries, count]);

  useEffect(() => {
    setSuggestedQueries(shuffleQueries());
  }, [shuffleQueries]);

  return {
    suggestedQueries,
  };
};

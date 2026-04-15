/**
 * React Query hook for fetching answers with JWT authentication.
 * Provides pagination functionality with answers sorted by most recent.
 */

import { useQuery, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import { queryFetch } from "@/utils/client/reactQueryConfig";
import { Answer } from "@/types/answer";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { DownvoteAnswerFilters, DownvoteFeedbackCluster } from "@/types/downvoteFeedback";

// Query keys for React Query cache
export const queryKeys = {
  answers: (page?: number) => ["answers", page].filter(Boolean),
  downvotedAnswers: (page: number = 1, filters?: DownvoteAnswerFilters) => ["downvotedAnswers", page, filters ?? {}],
  relatedQuestions: (docId?: string) => ["relatedQuestions", docId].filter(Boolean),
};

// Response type for the answers query
export interface AnswersResponse {
  answers: Answer[];
  totalPages: number;
  currentPage: number;
}

export interface DownvotedAnswersResponse {
  answers: Answer[];
  groups: DownvoteFeedbackCluster[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
}

type AnswersQueryKey = ReturnType<typeof queryKeys.answers>;

/**
 * Hook for fetching paginated answers (sorted by most recent)
 *
 * @param page - Current page number
 * @param options - Additional React Chat options
 */
export const useAnswers = (
  page: number = 1,
  options?: Omit<UseQueryOptions<AnswersResponse, Error, AnswersResponse, AnswersQueryKey>, "queryKey" | "queryFn">
): UseQueryResult<AnswersResponse, Error> => {
  return useQuery<AnswersResponse, Error, AnswersResponse, AnswersQueryKey>({
    queryKey: queryKeys.answers(page),
    queryFn: async () => {
      const url = `/api/answers?page=${page}&limit=10`;
      const response = await queryFetch(url, { method: "GET" });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.message || `Failed to fetch answers (${response.status})`) as Error & {
          status?: number;
        };
        error.status = response.status;
        throw error;
      }

      return response.json();
    },
    // More reasonable stale time for production
    staleTime: process.env.NODE_ENV === "production" ? 2 * 60 * 1000 : 5 * 60 * 1000,
    ...options,
  });
};

/**
 * Hook for fetching downvoted answers
 */
export function useDownvotedAnswers(page: number = 1, filters?: DownvoteAnswerFilters) {
  return useQuery<DownvotedAnswersResponse, Error>({
    queryKey: queryKeys.downvotedAnswers(page, filters),
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (filters?.triageStatus && filters.triageStatus !== "all") {
        params.set("triageStatus", filters.triageStatus);
      }
      if (filters?.triageCategory && filters.triageCategory !== "all") {
        params.set("triageCategory", filters.triageCategory);
      }
      if (filters?.feedbackReason && filters.feedbackReason !== "all") {
        params.set("feedbackReason", filters.feedbackReason);
      }
      if (filters?.identityMode && filters.identityMode !== "all") {
        params.set("identityMode", filters.identityMode);
      }
      if (filters?.groupBy && filters.groupBy !== "none") {
        params.set("groupBy", filters.groupBy);
      }

      const response = await fetchWithAuth(`/api/downvotedAnswers?${params.toString()}`);
      if (!response.ok) {
        const error = new Error("Failed to fetch downvoted answers") as Error & {
          status?: number;
        };
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
  });
}

/**
 * Hook for fetching related questions
 */
export function useRelatedQuestions(
  docId: string,
  options?: {
    enabled?: boolean;
    onSuccess?: (data: any) => void;
    onError?: (error: Error) => void;
  }
) {
  return useQuery({
    queryKey: queryKeys.relatedQuestions(docId),
    queryFn: async () => {
      const response = await queryFetch("/api/relatedQuestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId }),
      });

      if (!response.ok) {
        const error = new Error("Failed to fetch related questions") as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      return response.json();
    },
    staleTime: 60 * 60 * 1000, // Consider data fresh for 1 hour
    ...options,
  });
}

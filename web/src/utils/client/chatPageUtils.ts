import type { ExtendedAIMessage } from "@/types/ExtendedAIMessage";
import type { FilterConflictAction, TitleScopeFilterConflictPayload } from "@/types/titleScope";

export function getRepairAllLibrariesSelection(
  actionLibraries: string[] | undefined,
  defaultLibraries: string[]
): string[] {
  return actionLibraries ? [...actionLibraries] : [...defaultLibraries];
}

export function getAutoAppliedSourceFocusAction(
  payload: TitleScopeFilterConflictPayload
): FilterConflictAction | null {
  return (
    payload.actions.find((action) => action.kind === "setCollection" && action.collection === "whole_library") || null
  );
}

export function shouldShowSuggestions(messages: ExtendedAIMessage[]): boolean {
  if (!messages || messages.length === 0) return true;
  const userMessages = messages.filter((msg) => msg.type === "userMessage");
  return userMessages.length === 0;
}

import { resolveSuggestedQueriesCollectionKey } from "@/utils/client/collectionQueries";

export function getQueriesForCollection(
  collection: string,
  collectionQueries: Record<string, string[]>,
  collectionConfig?: Record<string, string> | null
): string[] {
  const resolvedCollection = resolveSuggestedQueriesCollectionKey(collection, collectionConfig);
  if (collectionQueries[resolvedCollection]) {
    return collectionQueries[resolvedCollection];
  }
  if (!collectionQueries[collection]) {
    const firstAvailableCollection = Object.keys(collectionQueries)[0];
    if (firstAvailableCollection) {
      return collectionQueries[firstAvailableCollection];
    }
    return [];
  }
  return collectionQueries[collection];
}

export type FilterExplicitnessPayload = {
  collection: boolean;
  libraries: boolean;
  mediaTypes: boolean;
};

export function buildFilterExplicitnessPayload(
  isTitleScopeSelectionEnabled: boolean,
  collectionChanged: boolean,
  librariesExplicit: boolean,
  mediaTypesExplicit: boolean
): FilterExplicitnessPayload | undefined {
  if (!isTitleScopeSelectionEnabled) {
    return undefined;
  }
  return {
    collection: collectionChanged,
    libraries: librariesExplicit,
    mediaTypes: mediaTypesExplicit,
  };
}

export type TimingMetricsDisplayInput = {
  ttfb?: number;
  tokensPerSecond?: number;
};

export function formatTimingMetricsDisplay(timingMetrics: TimingMetricsDisplayInput | null): string | null {
  if (!timingMetrics) return null;

  const { ttfb, tokensPerSecond } = timingMetrics;

  if (ttfb === undefined || tokensPerSecond === undefined) return null;

  const ttfbSecs = (ttfb / 1000).toFixed(2);
  return `${ttfbSecs} secs to first character, then ${tokensPerSecond} chars/sec streamed`;
}

export function generateChatPageTitle(conversationTitle: string | null, siteName: string): string {
  if (conversationTitle) {
    return `${conversationTitle} - ${siteName}`;
  }
  return siteName;
}

export function shouldUsePinnedChatShell(requireLogin: boolean, messageCount: number): boolean {
  return requireLogin || messageCount > 1;
}

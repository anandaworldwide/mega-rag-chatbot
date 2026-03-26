import { ResolvedTitleScope, TitleScopeSelection } from "@/types/titleScope";

export function buildTitleScopeForPersistence(
  resolvedTitleScope: ResolvedTitleScope | null | undefined,
  originalTitleScope: TitleScopeSelection | undefined
): TitleScopeSelection | undefined {
  if (!resolvedTitleScope) {
    return originalTitleScope;
  }

  return {
    canonicalPrefix: resolvedTitleScope.canonicalPrefix,
    displayTitle: resolvedTitleScope.displayTitle,
    userInput:
      originalTitleScope?.userInput || originalTitleScope?.displayTitle || originalTitleScope?.canonicalPrefix,
  };
}

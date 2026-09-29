import { useCallback, useEffect, useRef, useState } from "react";

export interface UseHideOnScrollOptions {
  /** When false, the bar stays visible and scroll position is ignored. */
  enabled?: boolean;
  /** Same-direction travel, in pixels, required before the bar toggles. */
  threshold?: number;
  /** Keep the bar visible, for example while the field is focused or holds unsent text. */
  forceVisible?: boolean;
  /** Distance from the bottom that counts as the end of the conversation. */
  bottomOffset?: number;
}

export interface UseHideOnScrollResult {
  hidden: boolean;
  /** Show the bar immediately, including while a scroll-to-bottom is in progress. */
  reveal: () => void;
}

const DEFAULT_THRESHOLD = 12;
const DEFAULT_BOTTOM_OFFSET = 48;

/**
 * Hides a pinned bar while the user scrolls down, and shows it again on scroll up,
 * at the bottom, or when `reveal` is called. Small movements under `threshold` are ignored.
 */
export function useHideOnScroll(
  scrollRef: { readonly current: HTMLElement | null } | null | undefined,
  {
    enabled = true,
    threshold = DEFAULT_THRESHOLD,
    forceVisible = false,
    bottomOffset = DEFAULT_BOTTOM_OFFSET,
  }: UseHideOnScrollOptions = {}
): UseHideOnScrollResult {
  const [hidden, setHidden] = useState(false);
  const forceVisibleRef = useRef(forceVisible);
  const lockVisibleRef = useRef(false);
  forceVisibleRef.current = forceVisible;

  const reveal = useCallback(() => {
    lockVisibleRef.current = true;
    setHidden(false);
  }, []);

  useEffect(() => {
    if (!enabled || forceVisible) {
      setHidden(false);
    }
  }, [enabled, forceVisible]);

  useEffect(() => {
    const el = scrollRef?.current;
    if (!enabled || !el) {
      return;
    }

    let lastTop = el.scrollTop;
    let accumulated = 0;

    const onScroll = () => {
      const top = el.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      const distanceFromBottom = el.scrollHeight - top - el.clientHeight;

      if (forceVisibleRef.current || distanceFromBottom <= bottomOffset) {
        accumulated = 0;
        lockVisibleRef.current = false;
        setHidden(false);
        return;
      }

      // Keep the bar visible through a programmatic scroll-to-bottom.
      if (lockVisibleRef.current) {
        if (delta < 0) {
          lockVisibleRef.current = false;
        } else {
          accumulated = 0;
          setHidden(false);
          return;
        }
      }

      if (delta === 0) {
        return;
      }

      if ((accumulated > 0 && delta < 0) || (accumulated < 0 && delta > 0)) {
        accumulated = 0;
      }
      accumulated += delta;

      if (accumulated >= threshold) {
        setHidden(true);
        accumulated = 0;
      } else if (accumulated <= -threshold) {
        setHidden(false);
        accumulated = 0;
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, enabled, threshold, bottomOffset]);

  return {
    hidden: enabled && !forceVisible ? hidden : false,
    reveal,
  };
}

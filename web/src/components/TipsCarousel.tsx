/**
 * TipsCarousel Component
 *
 * Displays tips in a carousel format with navigation dots and smooth transitions.
 * Each tip is shown on a separate slide with previous/next navigation.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { logEvent } from "@/utils/client/analytics";
import { Tip } from "@/utils/client/loadTips";

interface TipsCarouselProps {
  tips: Tip[];
}

export const TipsCarousel: React.FC<TipsCarouselProps> = ({ tips }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);

  const goToNext = useCallback(
    (method = "unknown") => {
      const newIndex = (currentIndex + 1) % tips.length;
      setCurrentIndex(newIndex);
      logEvent("tips_navigate_next", "Tips", method, newIndex + 1);
    },
    [currentIndex, tips.length]
  );

  const goToPrevious = useCallback(
    (method = "unknown") => {
      const newIndex = (currentIndex - 1 + tips.length) % tips.length;
      setCurrentIndex(newIndex);
      logEvent("tips_navigate_previous", "Tips", method, newIndex + 1);
    },
    [currentIndex, tips.length]
  );

  const goToIndex = (index: number, method = "unknown") => {
    if (index === currentIndex) return;
    setCurrentIndex(index);
    logEvent("tips_navigate_direct", "Tips", method, index + 1);
  };

  // Handle swipe gestures
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;

    const distance = touchStartX.current - touchEndX.current;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe && tips.length > 1) {
      goToNext("swipe");
    }
    if (isRightSwipe && tips.length > 1) {
      goToPrevious("swipe");
    }
  };

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        goToPrevious("keyboard");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        goToNext("keyboard");
      }
      // Note: Escape key is handled by the parent TipsModal component
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [goToPrevious, goToNext]);

  const currentTip = tips[currentIndex];

  return (
    <div className="w-full" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      {/* Tip Content */}
      <div className="min-h-[200px] mb-6">
        <div className="opacity-100 transition-opacity duration-300">
          <h4 className="text-lg font-semibold text-gray-900 mb-3">{currentTip.title}</h4>

          {/* GIF Display - positioned above content by default */}
          {currentTip.gif && currentTip.gif.position !== "below" && (
            <div className="mb-6 flex justify-center">
              <div className="relative bg-gradient-to-br from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-100 shadow-lg">
                <img
                  src={currentTip.gif.url}
                  alt={currentTip.gif.alt}
                  width={currentTip.gif.width}
                  height={currentTip.gif.height}
                  className="max-w-full h-auto rounded-lg shadow-md"
                  style={{
                    maxWidth: "100%",
                    height: "auto",
                    aspectRatio: `${currentTip.gif.width} / ${currentTip.gif.height}`,
                  }}
                  loading="lazy"
                />
                {/* Optional: Add a small "Demo" label */}
                <div className="absolute top-2 right-2 bg-blue-600 text-white text-xs px-2 py-1 rounded-full font-medium shadow-sm">
                  Demo
                </div>
              </div>
            </div>
          )}

          <div className="prose prose-sm max-w-none">
            {currentTip.content.split("\n\n").map((paragraph, index) => (
              <p key={index} className="text-gray-700 leading-relaxed mb-4 last:mb-0">
                {paragraph}
              </p>
            ))}
          </div>

          {/* GIF Display - positioned below content */}
          {currentTip.gif && currentTip.gif.position === "below" && (
            <div className="mt-6 flex justify-center">
              <div className="relative bg-gradient-to-br from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-100 shadow-lg">
                <img
                  src={currentTip.gif.url}
                  alt={currentTip.gif.alt}
                  width={currentTip.gif.width}
                  height={currentTip.gif.height}
                  className="max-w-full h-auto rounded-lg shadow-md"
                  style={{
                    maxWidth: "100%",
                    height: "auto",
                    aspectRatio: `${currentTip.gif.width} / ${currentTip.gif.height}`,
                  }}
                  loading="lazy"
                />
                {/* Optional: Add a small "Demo" label */}
                <div className="absolute top-2 right-2 bg-blue-600 text-white text-xs px-2 py-1 rounded-full font-medium shadow-sm">
                  Demo
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Controls */}
      <div className="flex items-center justify-between">
        {/* Previous Button */}
        <button
          onClick={() => goToPrevious("button")}
          disabled={tips.length <= 1}
          className="flex items-center justify-center w-10 h-10 rounded-full border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label="Previous tip"
        >
          <span className="material-icons text-gray-600">chevron_left</span>
        </button>

        {/* Navigation Dots */}
        <div className="flex space-x-2">
          {tips.map((_, index) => (
            <button
              key={index}
              onClick={() => goToIndex(index, "dot")}
              disabled={tips.length <= 1}
              className={`w-2 h-2 rounded-full transition-all duration-200 ${
                index === currentIndex ? "bg-blue-500 scale-125" : "bg-gray-300 hover:bg-gray-400"
              }`}
              aria-label={`Go to tip ${index + 1}`}
            />
          ))}
        </div>

        {/* Next Button */}
        <button
          onClick={() => goToNext("button")}
          disabled={tips.length <= 1}
          className="flex items-center justify-center w-10 h-10 rounded-full border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label="Next tip"
        >
          <span className="material-icons text-gray-600">chevron_right</span>
        </button>
      </div>
    </div>
  );
};

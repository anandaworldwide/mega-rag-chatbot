import React, { useState, useEffect, useRef } from "react";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteWhatsNew, WhatsNewData } from "@/utils/client/loadWhatsNew";
import { isAuthenticated, getToken } from "@/utils/client/tokenManager";
import { logEvent } from "@/utils/client/analytics";

interface WhatsNewDropdownProps {
  siteConfig: SiteConfig | null;
  requireLogin: boolean;
}

export default function WhatsNewDropdown({ siteConfig, requireLogin }: WhatsNewDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [whatsNewData, setWhatsNewData] = useState<WhatsNewData | null>(null);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!siteConfig) return;

    loadSiteWhatsNew(siteConfig)
      .then((data) => {
        if (data) {
          setWhatsNewData(data);
          setCurrentVersion(data.version);
        }
      })
      .catch(() => {
        // Component won't render if data doesn't exist
      });
  }, [siteConfig]);

  useEffect(() => {
    if (currentVersion === null || !siteConfig) {
      setHasNewUpdates(false);
      return;
    }

    const checkVersion = async () => {
      if (requireLogin && isAuthenticated()) {
        try {
          const token = await getToken();
          const response = await fetch("/api/user/whats-new", {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
          });

          if (response.ok) {
            const data = await response.json();
            const lastSeenVersion = data.lastSeenWhatsNewVersion || 0;
            setHasNewUpdates(lastSeenVersion < currentVersion);
          } else {
            // Fallback to localStorage
            const localLastSeenVersion = parseInt(
              localStorage.getItem("lastSeenWhatsNewVersion") || "0",
              10
            );
            setHasNewUpdates(localLastSeenVersion < currentVersion);
          }
        } catch {
          // Fallback to localStorage
          const localLastSeenVersion = parseInt(
            localStorage.getItem("lastSeenWhatsNewVersion") || "0",
            10
          );
          setHasNewUpdates(localLastSeenVersion < currentVersion);
        }
      } else {
        // Use localStorage for non-login sites
        const localLastSeenVersion = parseInt(
          localStorage.getItem("lastSeenWhatsNewVersion") || "0",
          10
        );
        setHasNewUpdates(localLastSeenVersion < currentVersion);
      }
    };

    checkVersion();
  }, [currentVersion, siteConfig, requireLogin]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        buttonRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  const calculateDropdownPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 8;
    const dropdownWidth = 320; // w-80
    const isMobile = window.innerWidth < 768;

    let top = rect.bottom + gap;
    let left: number;

    if (isMobile) {
      // Center horizontally on mobile
      left = (window.innerWidth - dropdownWidth) / 2;
    } else {
      // Align with button on desktop
      left = rect.right - dropdownWidth;
    }

    // Ensure dropdown doesn't go off left edge
    if (left < 10) {
      left = 10;
    }

    // Ensure dropdown doesn't go off right edge
    if (left + dropdownWidth > window.innerWidth - 10) {
      left = window.innerWidth - dropdownWidth - 10;
    }

    setDropdownPosition({ top: Math.max(10, top), left: Math.max(10, left) });

    // After first paint, check if dropdown height causes overflow and move above if needed
    requestAnimationFrame(() => {
      const height = dropdownRef.current?.offsetHeight || 0;
      const bottom = top + height;
      if (bottom > window.innerHeight - 10) {
        top = Math.max(10, rect.top - height - gap);
        setDropdownPosition({ top, left: Math.max(10, left) });
      }
    });
  };

  useEffect(() => {
    if (isOpen) {
      calculateDropdownPosition();

      const handleResize = () => calculateDropdownPosition();
      const handleScroll = () => calculateDropdownPosition();

      window.addEventListener("resize", handleResize);
      window.addEventListener("scroll", handleScroll, true);

      return () => {
        window.removeEventListener("resize", handleResize);
        window.removeEventListener("scroll", handleScroll, true);
      };
    }
  }, [isOpen]);

  const handleOpen = () => {
    setIsOpen(true);
    logEvent("whats_new_dropdown_open", "What's New", "bell_click");

    if (currentVersion !== null) {
      if (requireLogin && isAuthenticated()) {
        getToken()
          .then((token) => {
            return fetch("/api/user/whats-new", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                lastSeenWhatsNewVersion: currentVersion,
              }),
            });
          })
          .then(() => {
            setHasNewUpdates(false);
            logEvent("whats_new_version_updated", "What's New", "api_success");
          })
          .catch(() => {
            // Fallback to localStorage
            localStorage.setItem("lastSeenWhatsNewVersion", currentVersion.toString());
            setHasNewUpdates(false);
            logEvent("whats_new_version_updated", "What's New", "localStorage");
          });
      } else {
        localStorage.setItem("lastSeenWhatsNewVersion", currentVersion.toString());
        setHasNewUpdates(false);
        logEvent("whats_new_version_updated", "What's New", "localStorage");
      }
    }
  };

  const formatDate = (dateString: string): string => {
    try {
      const [year, month, day] = dateString.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return dateString;
    }
  };

  if (!whatsNewData) {
    return null;
  }

  const displayEntries = whatsNewData.entries.slice(0, 3);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleOpen}
        aria-label="What's New"
        className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center relative"
        title="What's New"
      >
        <span className="material-icons text-xl" aria-hidden="true">
          notifications
        </span>
        {hasNewUpdates && (
          <span className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border-2 border-[#0092e3]"></span>
        )}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="fixed w-80 bg-white rounded-lg shadow-xl z-50 border border-gray-200 overflow-y-auto"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            maxHeight: "calc(100vh - 20px)",
          }}
        >
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-lg text-gray-900">What&apos;s New</h3>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Close"
              >
                <span className="material-icons text-xl" aria-hidden="true">
                  close
                </span>
              </button>
            </div>

            <div className="space-y-4 mb-4">
              {displayEntries.map((entry, index) => (
                <div key={index} className="border-b border-gray-100 last:border-b-0 pb-3 last:pb-0">
                  <div className="text-xs text-gray-500 mb-1">{formatDate(entry.date)}</div>
                  <div className="font-semibold text-gray-900 mb-1">{entry.title}</div>
                  <div className="text-sm text-gray-600">{entry.description}</div>
                </div>
              ))}
            </div>

            <a
              href={whatsNewData.wikiUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                logEvent("whats_new_view_all", "What's New", "wiki_link_click");
              }}
              className="block text-center text-sm text-blue-600 hover:text-blue-800 font-medium py-2 border-t border-gray-200 pt-3"
            >
              View all updates →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

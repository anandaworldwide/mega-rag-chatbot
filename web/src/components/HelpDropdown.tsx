/**
 * HelpDropdown Component
 *
 * This component provides a dropdown menu with help-related options:
 * - Tips and tricks
 * - Help page link
 * - About the open source project
 */

import React, { useState, useEffect, useRef } from "react";
import { SiteConfig } from "@/types/siteConfig";
import { areTipsAvailable, loadSiteTips, TipsData } from "@/utils/client/loadTips";
import { TipsModal } from "@/components/TipsModal";
import { OpenSourceModal } from "@/components/OpenSourceModal";
import { isAuthenticated, getToken } from "@/utils/client/tokenManager";
import { logEvent } from "@/utils/client/analytics";

interface HelpDropdownProps {
  siteConfig: SiteConfig | null;
  helpUrl?: string;
  requireLogin: boolean;
}

export default function HelpDropdown({ siteConfig, helpUrl, requireLogin }: HelpDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showTipsModal, setShowTipsModal] = useState(false);
  const [showOpenSourceModal, setShowOpenSourceModal] = useState(false);
  const [tipsAvailable, setTipsAvailable] = useState(false);
  const [hasNewTips, setHasNewTips] = useState(false);
  const [currentTipsVersion, setCurrentTipsVersion] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Check if tips are available
  useEffect(() => {
    if (siteConfig) {
      areTipsAvailable(siteConfig).then(setTipsAvailable);
    }
  }, [siteConfig]);

  // Load tips version when tips become available
  useEffect(() => {
    if (tipsAvailable && currentTipsVersion === null && siteConfig) {
      loadSiteTips(siteConfig)
        .then((tipsData: TipsData | null) => {
          if (tipsData) {
            setCurrentTipsVersion(tipsData.version);
          }
        })
        .catch(() => {
          // Silently fail - tips just won't show new indicator
        });
    }
  }, [tipsAvailable, currentTipsVersion, siteConfig]);

  // Check if there are new tips
  useEffect(() => {
    if (!tipsAvailable || currentTipsVersion === null) {
      setHasNewTips(false);
      return;
    }

    let timeoutId: NodeJS.Timeout | null = null;

    const checkTipsStatus = async () => {
      if (siteConfig?.requireLogin) {
        const authStatus = isAuthenticated();

        if (authStatus) {
          try {
            const token = await getToken();
            const response = await fetch("/api/user/tips", {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
            });

            if (response.ok) {
              const data = await response.json();
              const lastSeenVersion = data.lastSeenTipVersion || 0;
              setHasNewTips(lastSeenVersion < currentTipsVersion);
            } else {
              const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
              setHasNewTips(localLastSeenVersion < currentTipsVersion);
            }
          } catch {
            const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
            setHasNewTips(localLastSeenVersion < currentTipsVersion);
          }
        } else {
          const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
          setHasNewTips(localLastSeenVersion < currentTipsVersion);
        }
      } else {
        const localLastSeenVersion = parseInt(localStorage.getItem("lastSeenTipVersion") || "0", 10);
        setHasNewTips(localLastSeenVersion < currentTipsVersion);
      }
    };

    // Debounce the check
    timeoutId = setTimeout(checkTipsStatus, 100);

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [tipsAvailable, currentTipsVersion, siteConfig, requireLogin]);

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
        logEvent("help_dropdown_close", "Help", "click_outside");
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
        logEvent("help_dropdown_close", "Help", "escape_key");
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  // Calculate dropdown position
  const calculateDropdownPosition = () => {
    if (!buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 8;
    const dropdownWidth = 200;
    const isMobile = window.innerWidth < 768;

    let top = rect.bottom + gap;
    let left: number;

    if (isMobile) {
      left = (window.innerWidth - dropdownWidth) / 2;
    } else {
      left = rect.right - dropdownWidth;
    }

    if (left < 10) {
      left = 10;
    }

    if (left + dropdownWidth > window.innerWidth - 10) {
      left = window.innerWidth - dropdownWidth - 10;
    }

    setDropdownPosition({ top: Math.max(10, top), left: Math.max(10, left) });

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
    logEvent("help_dropdown_open", "Help", "button_click");
  };

  const handleTipsClick = () => {
    setIsOpen(false);
    setShowTipsModal(true);
    logEvent("tips_modal_open", "Tips", "help_dropdown");
  };

  const handleTipsClose = () => {
    setShowTipsModal(false);
    logEvent("tips_modal_close", "Tips", "modal_close");

    // Mark tips as seen
    if (currentTipsVersion && hasNewTips && siteConfig?.requireLogin) {
      const authStatus = isAuthenticated();

      if (authStatus) {
        getToken()
          .then((token) => {
            return fetch("/api/user/tips", {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                lastSeenTipVersion: currentTipsVersion,
              }),
            });
          })
          .then(() => {
            setHasNewTips(false);
            logEvent("tips_version_updated", "Tips", "api_success");
          })
          .catch(() => {
            localStorage.setItem("lastSeenTipVersion", currentTipsVersion.toString());
            setHasNewTips(false);
            logEvent("tips_version_updated", "Tips", "localStorage");
          });
      } else {
        localStorage.setItem("lastSeenTipVersion", currentTipsVersion.toString());
        setHasNewTips(false);
        logEvent("tips_version_updated", "Tips", "localStorage");
      }
    } else if (currentTipsVersion && hasNewTips) {
      localStorage.setItem("lastSeenTipVersion", currentTipsVersion.toString());
      setHasNewTips(false);
      logEvent("tips_version_updated", "Tips", "localStorage");
    }
  };

  const handleOpenSourceClick = () => {
    setIsOpen(false);
    setShowOpenSourceModal(true);
    logEvent("open_source_modal_open", "Help", "help_dropdown");
  };

  const handleHelpPageClick = () => {
    setIsOpen(false);
    logEvent("help_page_click", "Help", "help_dropdown");
  };

  // Always render - open source option is always available

  const githubUrl =
    siteConfig?.footer?.links?.find((link) => link.label.toLowerCase().includes("open source"))?.url ||
    "https://github.com/anandaworldwide/mega-rag-chatbot";

  return (
    <>
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={handleOpen}
          aria-label="Help"
          className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center relative"
          title="Help"
        >
          <span className="material-icons text-xl">help_outline</span>
          {hasNewTips && (
            <span className="absolute top-0 right-0 w-2 h-2 bg-blue-500 rounded-full border-2 border-[#0092e3]"></span>
          )}
        </button>

        {isOpen && (
          <div
            ref={dropdownRef}
            className="fixed bg-white rounded-lg shadow-xl z-50 border border-gray-200 overflow-hidden"
            style={{
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              minWidth: "200px",
            }}
          >
            <div className="py-1">
              {tipsAvailable && (
                <button
                  onClick={handleTipsClick}
                  className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center justify-between"
                >
                  <span className="flex items-center">
                    <span className="material-icons text-base mr-2">lightbulb</span>
                    Tips
                  </span>
                  {hasNewTips && <span className="w-2 h-2 bg-blue-500 rounded-full"></span>}
                </button>
              )}
              {helpUrl && (
                <a
                  href={helpUrl}
                  onClick={handleHelpPageClick}
                  className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                >
                  <span className="material-icons text-base mr-2">help_outline</span>
                  Help Page
                </a>
              )}
              <button
                onClick={handleOpenSourceClick}
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
              >
                <span className="material-icons text-base mr-2">code</span>
                About the Open Source Project
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tips Modal */}
      {siteConfig && (
        <TipsModal
          isOpen={showTipsModal}
          onClose={handleTipsClose}
          siteConfig={siteConfig}
          onVersionLoaded={setCurrentTipsVersion}
        />
      )}

      {/* Open Source Modal */}
      <OpenSourceModal
        isOpen={showOpenSourceModal}
        onClose={() => setShowOpenSourceModal(false)}
        githubUrl={githubUrl}
      />
    </>
  );
}

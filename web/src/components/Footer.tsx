// Footer component for the application
import React from "react";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { getFooterConfig } from "@/utils/client/siteConfig";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useSudo } from "@/contexts/SudoContext";
import { isAuthenticated } from "@/utils/client/tokenManager";

interface FooterProps {
  siteConfig: SiteConfig | null;
}

const Footer: React.FC<FooterProps> = ({ siteConfig }) => {
  const [isAdminRole, setIsAdminRole] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const { isSudoUser } = useSudo();
  const router = useRouter();

  useEffect(() => {
    let mounted = true;

    async function checkRole() {
      // Early return: Skip API call if site doesn't require login
      if (!siteConfig?.requireLogin) {
        if (mounted) setIsAdminRole(false);
        return;
      }

      // Early return: Skip API call if user is not authenticated
      if (!isAuthenticated()) {
        if (mounted) setIsAdminRole(false);
        // Clear cache when user is not authenticated
        try {
          sessionStorage.removeItem("userRole");
        } catch {
          // sessionStorage not available, continue
        }
        return;
      }

      // Check sessionStorage cache first (1-minute TTL for faster role updates)
      try {
        const cached = sessionStorage.getItem("userRole");
        if (cached) {
          const parsed = JSON.parse(cached);
          const isExpired = Date.now() - parsed.timestamp > 60 * 1000; // 1 minute (reduced from 5 minutes)
          if (!isExpired && parsed.role) {
            const isAdmin = parsed.role === "admin" || parsed.role === "superuser";
            if (mounted) setIsAdminRole(isAdmin);
            return; // Use cached result
          }
        }
      } catch {
        // Invalid cache, continue to API call
      }

      // Make API call only when necessary
      try {
        const res = await fetch("/api/profile", { credentials: "include" });
        if (!res.ok) {
          if (mounted) setIsAdminRole(false);
          return;
        }

        const data = await res.json();
        const role = (data?.role as string) || "user";
        const isAdmin = role === "admin" || role === "superuser";
        const isSuper = role === "superuser";

        // Cache the result
        try {
          sessionStorage.setItem(
            "userRole",
            JSON.stringify({
              role,
              timestamp: Date.now(),
            })
          );
        } catch {
          // sessionStorage failed, continue without caching
        }

        if (mounted) {
          setIsAdminRole(isAdmin);
          setIsSuperuser(isSuper);
        }
      } catch {
        if (mounted) setIsAdminRole(false);
      }
    }

    checkRole();

    // Listen for storage events to refresh role when it changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "userRole" && mounted) {
        checkRole();
      }
    };
    window.addEventListener("storage", handleStorageChange);

    return () => {
      mounted = false;
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [router.asPath, siteConfig?.requireLogin]);
  const footerConfig = getFooterConfig(siteConfig);

  const showAdminSection = siteConfig?.requireLogin ? isAdminRole : isSudoUser;

  return (
    <>
      {/* Admin section for admins/superusers via JWT role */}
      {showAdminSection && (
        <div className="bg-gray-100 text-gray-700 py-2 border-t border-t-slate-200 mt-4">
          <div className="mx-auto max-w-[800px] px-4">
            <div className="flex flex-col items-center w-full">
              <div className="flex flex-row justify-center items-center w-full gap-2">
                {isSuperuser && siteConfig?.requireLogin && (
                  <>
                    <Link href="/answers" className="text-sm hover:text-slate-600 cursor-pointer flex items-center">
                      View all answers
                      <span className="material-icons text-sm ml-1">question_answer</span>
                    </Link>
                    <span className="text-gray-400">|</span>
                  </>
                )}
                <Link href="/admin" className="text-sm hover:text-slate-600 cursor-pointer flex items-center">
                  Admin Dashboard
                  <span className="material-icons text-sm ml-1">dashboard</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Main footer section */}
      <footer className="bg-white text-gray-500 py-4 border-t border-t-slate-200">
        <div className="mx-auto max-w-[800px] px-4">
          <div className="flex flex-wrap justify-center items-center">
            {footerConfig.links.map((link, index) => {
              // Add default icons if not specified in config
              let icon = link.icon;
              if (!icon) {
                switch (link.label.toLowerCase()) {
                  case "help":
                    icon = "help_outline";
                    break;
                  case "contact":
                    icon = "mail_outline";
                    break;
                  case "open source":
                  case "open source project":
                    icon = "code";
                    break;
                  case "compare ai models":
                    icon = "compare";
                    break;
                }
              }

              const content = (
                <>
                  {link.label}
                  {icon && <span className="material-icons text-sm ml-1">{icon}</span>}
                </>
              );

              // Render non-clickable text
              if (!link.url) {
                return (
                  <span key={index} className="text-sm mx-2 my-1 inline-flex items-center">
                    {content}
                  </span>
                );
              }

              const isExternal = link.url.startsWith("http") || link.url.startsWith("//");

              // Render external link
              if (isExternal) {
                return (
                  <a
                    key={index}
                    href={link.url}
                    className="text-sm hover:text-slate-600 cursor-pointer mx-2 my-1 inline-flex items-center"
                  >
                    {content}
                  </a>
                );
              } else {
                // Render internal link
                return (
                  <Link
                    key={index}
                    href={link.url}
                    className="text-sm hover:text-slate-600 cursor-pointer mx-2 my-1 inline-flex items-center"
                  >
                    {content}
                  </Link>
                );
              }
            })}
          </div>
        </div>
      </footer>
      {/* Mobile spacing for feedback button */}
      <div className="pb-20 md:pb-0" />
    </>
  );
};

export default Footer;

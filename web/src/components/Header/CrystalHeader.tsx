import React from "react";
import Image from "next/image";
import Link from "next/link";
import { SiteConfig } from "@/types/siteConfig";
import { getParentSiteUrl, getEnableSearchPage } from "@/utils/client/siteConfig";

interface CrystalHeaderProps {
  siteConfig: SiteConfig;
  onNewChat?: () => void;
}

export default function CrystalHeader({ siteConfig, onNewChat }: CrystalHeaderProps) {
  const parentSiteUrl = getParentSiteUrl(siteConfig);

  return (
    <header className="sticky top-0 z-50 w-full">
      <div
        className="bg-[#0092e3] relative h-[68px]"
        style={{
          backgroundImage:
            "url('data:image/svg+xml;utf8,<svg viewBox=\\\'0 0 1512 68\\\' xmlns=\\\'http://www.w3.org/2000/svg\\\' preserveAspectRatio=\\\'none\\\'><rect x=\\\'0\\\' y=\\\'0\\\' height=\\\'100%\\\' width=\\\'100%\\\' fill=\\\'url(%23grad)\\\' opacity=\\\'0.20000000298023224\\\'/><defs><radialGradient id=\\\'grad\\\' gradientUnits=\\\'userSpaceOnUse\\\' cx=\\\'0\\\' cy=\\\'0\\\' r=\\\'10\\\' gradientTransform=\\\'matrix(62.9 2.8609e-7 -7.2655e-8 15.974 756 34)\\\'><stop stop-color=\\\'rgba(255,255,255,0.2)\\\' offset=\\\'0\\\'/><stop stop-color=\\\'rgba(128,201,241,0.2)\\\' offset=\\\'0.5\\\'/><stop stop-color=\\\'rgba(64,173,234,0.2)\\\' offset=\\\'0.75\\\'/><stop stop-color=\\\'rgba(0,146,227,0.2)\\\' offset=\\\'1\\\'/></radialGradient></defs></svg>')",
        }}
      >
        <div className="flex justify-between items-center h-full px-[35px]">
          <div className="flex items-center gap-[35px] pt-[5px]">
            <Link href="/">
              <Image
                src="https://www.crystalclarity.com/cdn/shop/files/logo-white.png?v=1671755975&width=382"
                alt="Crystal Clarity Publishers"
                width={200}
                height={32}
                sizes="(max-width: 200px) 200px, 200px"
                className="header__logo-image cursor-pointer"
                priority
              />
            </Link>
            <nav>
              <div className="flex items-center gap-[35px]">
                <Link
                  href="/"
                  className="font-['Open_Sans'] font-bold text-[18px] text-white hover:text-gray-200 cursor-pointer"
                  style={{ fontVariationSettings: "'wdth' 100" }}
                >
                  Home
                </Link>
              </div>
            </nav>
          </div>
          <div className="flex items-center space-x-4">
            {/* Show new chat button */}
            {onNewChat && (
              <button
                onClick={onNewChat}
                aria-label="New Chat"
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors"
                title="Start New Chat"
              >
                <span className="material-icons text-xl">edit_square</span>
              </button>
            )}
            {getEnableSearchPage(siteConfig) && (
              <Link
                href="/search"
                className="text-white hover:text-gray-200 p-1 rounded-xl hover:bg-white/10 transition-colors flex items-center"
                title="Search Passages"
              >
                <span className="material-icons text-xl">search</span>
              </Link>
            )}
            <Link
              href={parentSiteUrl}
              className="font-['Open_Sans'] font-bold text-[18px] text-white hover:text-gray-200 cursor-pointer"
            >
              Back to Main Site &gt;
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

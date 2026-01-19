import BaseHeader from "./BaseHeader";
import { SiteConfig } from "@/types/siteConfig";
import { getParentSiteUrl, getParentSiteName, getEnableSearchPage } from "@/utils/client/siteConfig";
import Image from "next/image";

interface AnandaHeaderProps {
  siteConfig: SiteConfig;
  onNewChat?: () => void;
  temporarySession?: boolean;
  onTemporarySessionChange?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  isChatEmpty?: boolean;
}

export default function AnandaHeader({
  siteConfig,
  onNewChat,
  temporarySession,
  onTemporarySessionChange,
  isChatEmpty,
}: AnandaHeaderProps) {
  const parentSiteUrl = getParentSiteUrl(siteConfig);
  const parentSiteName = getParentSiteName(siteConfig);

  // Create logo component if loginImage is configured
  const logoComponent = siteConfig.loginImage ? (
    <Image
      src={`/${siteConfig.loginImage}`}
      alt={`${siteConfig.shortname || siteConfig.name} Logo`}
      width={50}
      height={50}
      className="h-[50px] w-auto object-contain"
      priority
    />
  ) : null;

  return (
    <>
      <BaseHeader
        config={siteConfig.header}
        siteConfig={siteConfig}
        parentSiteUrl={parentSiteUrl}
        parentSiteName={parentSiteName}
        requireLogin={siteConfig.requireLogin}
        onNewChat={onNewChat}
        temporarySession={temporarySession}
        onTemporarySessionChange={onTemporarySessionChange}
        isChatEmpty={isChatEmpty}
        allowTemporarySessions={siteConfig.allowTemporarySessions}
        logoComponent={logoComponent}
        helpUrl={siteConfig.help_url}
        enableSearchPage={getEnableSearchPage(siteConfig)}
      />
    </>
  );
}

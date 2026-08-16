import BaseHeader from "./BaseHeader";
import { SiteConfig } from "@/types/siteConfig";
import { getParentSiteUrl, getParentSiteName } from "@/utils/client/siteConfig";

interface PhotoHeaderProps {
  siteConfig: SiteConfig;
  onNewChat?: () => void;
  temporarySession?: boolean;
  onTemporarySessionChange?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  isChatEmpty?: boolean;
}

export default function PhotoHeader({
  siteConfig,
  onNewChat,
  temporarySession,
  onTemporarySessionChange,
  isChatEmpty,
}: PhotoHeaderProps) {
  const parentSiteUrl = getParentSiteUrl(siteConfig);
  const parentSiteName = getParentSiteName(siteConfig);

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
      />
    </>
  );
}

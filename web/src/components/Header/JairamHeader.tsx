import BaseHeader from "./BaseHeader";
import { SiteConfig } from "@/types/siteConfig";
import { getParentSiteUrl, getParentSiteName } from "@/utils/client/siteConfig";

interface JairamHeaderProps {
  siteConfig: SiteConfig;
  onNewChat?: () => void;
  onFeedbackClick?: () => void;
}

export default function JairamHeader({ siteConfig, onNewChat, onFeedbackClick }: JairamHeaderProps) {
  const parentSiteUrl = getParentSiteUrl(siteConfig);
  const parentSiteName = getParentSiteName(siteConfig);

  return (
      <BaseHeader
        config={siteConfig.header}
        siteConfig={siteConfig}
        parentSiteUrl={parentSiteUrl}
        parentSiteName={parentSiteName}
        requireLogin={siteConfig.requireLogin}
        onNewChat={onNewChat}
        temporarySession={false}
        onTemporarySessionChange={undefined}
        isChatEmpty={true}
        allowTemporarySessions={false}
        onFeedbackClick={onFeedbackClick}
      />
  );
}

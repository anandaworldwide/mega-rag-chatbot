/**
 * /chat/[convId] is the home chat UI at a pretty URL.
 *
 * Do not router.replace("/", "/chat/id"). That client transition fetches
 * /_next/data/{buildId}/chat/{id}.json?convId={id} and 404s, leaving the
 * old spinner on screen forever. The HTML document for this route is 200.
 */

import Home from "../index";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
import { SiteConfig } from "@/types/siteConfig";

export default function ChatConversation(props: { siteConfig: SiteConfig | null }) {
  return <Home {...props} />;
}

ChatConversation.getInitialProps = async () => {
  const result = await getCommonSiteConfigProps();
  return result.props;
};

/**
 * /chat/[convId] is the home chat UI at a pretty URL.
 *
 * Do not router.replace("/", "/chat/id"). Production Vivek proves the document
 * GET /chat/{id} is 200 (x-matched-path: /chat/[convId]) while
 * /_next/data/{build}/chat/{id}.json?convId={id} is 404 HTML
 * (x-matched-path: /_not-found). Same 404 without the query. The query is
 * Next's [convId] param, not an extra client query. getInitialProps does not
 * create a Vercel data function; getServerSideProps does (see /answers.json).
 */

import Home from "../index";
import { GetServerSideProps } from "next";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";
import { SiteConfig } from "@/types/siteConfig";

export default function ChatConversation(props: { siteConfig: SiteConfig | null }) {
  return <Home {...props} />;
}

export const getServerSideProps: GetServerSideProps<{ siteConfig: SiteConfig | null }> = async () => {
  return getCommonSiteConfigProps();
};

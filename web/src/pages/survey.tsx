import React from "react";
import { GetServerSideProps } from "next";
import Head from "next/head";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { SiteConfig } from "@/types/siteConfig";
import NPSSurvey from "@/components/NPSSurvey";
import { verifyNpsSurveyToken } from "@/utils/server/npsSurveyTokenUtils";
import Layout from "@/components/layout";

interface SurveyPageProps {
  siteConfig: SiteConfig;
  initialScore: number | null;
}

const SurveyPage: React.FC<SurveyPageProps> = ({ siteConfig, initialScore }) => {
  return (
    <>
      <Head>
        <title>Survey - {siteConfig.shortname}</title>
      </Head>
      <Layout siteConfig={siteConfig}>
        <div className="flex flex-col h-full">
          <div className="flex-grow overflow-auto">
            <div className="max-w-2xl mx-auto px-4 py-8">
              <NPSSurvey siteConfig={siteConfig} initialScore={initialScore} />
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
};

export const getServerSideProps: GetServerSideProps = async (context) => {
  const siteId = process.env.SITE_ID || "default";
  const siteConfig = loadSiteConfigSync(siteId);

  if (!siteConfig) {
    return {
      notFound: true,
    };
  }

  // Parse query params for score and token
  const scoreParam = context.query.score;
  const tokenParam = context.query.token;

  let initialScore: number | null = null;

  if (scoreParam && tokenParam && typeof scoreParam === "string" && typeof tokenParam === "string") {
    // Validate token
    const tokenPayload = verifyNpsSurveyToken(tokenParam);
    if (tokenPayload && tokenPayload.isValid) {
      // Use score from token (more secure) but validate it matches query param
      const scoreFromToken = tokenPayload.score;
      const scoreFromQuery = parseInt(scoreParam, 10);

      if (scoreFromToken === scoreFromQuery && scoreFromToken >= 0 && scoreFromToken <= 10) {
        initialScore = scoreFromToken;
      }
    }
  }

  return {
    props: {
      siteConfig,
      initialScore,
    },
  };
};

export default SurveyPage;

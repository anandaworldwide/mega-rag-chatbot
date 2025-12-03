/**
 * Chat conversation route - redirects to home page
 * This handles URLs like /chat/[convId] by redirecting to the home page
 * where the URL detection logic will load the conversation and set the title
 */

import { useRouter } from "next/router";
import { useEffect } from "react";
import { getCommonSiteConfigProps } from "@/utils/server/getCommonSiteConfigProps";

export default function ChatConversation() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) {
      return;
    }

    const { convId } = router.query;
    if (!convId || typeof convId !== "string") {
      router.replace("/");
      return;
    }

    // Preserve hash fragment if present (for source deep linking)
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const targetPath = hash ? `/chat/${convId}${hash}` : `/chat/${convId}`;

    // Navigate to home page, preserving the /chat/[convId] path and hash in the URL
    // The home page will detect this path and load the conversation
    // Use replace with the 'as' parameter to show /chat/[convId] in the URL
    // but render the home page component
    router.replace("/", targetPath, { shallow: false });
  }, [router.isReady, router.query, router]);

  // Simple loading display (no title setting to avoid flashing)
  return (
    <div className="flex justify-center items-center h-screen">
      <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"></div>
      <p className="text-lg text-gray-600 ml-4">Loading conversation...</p>
    </div>
  );
}

// Fetch initial props for the page
ChatConversation.getInitialProps = async () => {
  const result = await getCommonSiteConfigProps();
  return result.props;
};

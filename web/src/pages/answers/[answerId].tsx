// This component renders a single answer page, fetching and displaying the answer details,
// handling votes, and providing admin functionality for deletion.

// Special features:
// - GETHUMAN links: For the 'ananda-public' site ID, links in the format [text](GETHUMAN)
//   are automatically converted to links to the Ananda contact page (https://www.ananda.org/contact-us/)

import { SiteConfig } from "@/types/siteConfig";
import { useRouter } from "next/router";
import { useEffect, useState, useRef } from "react";
import Layout from "@/components/layout";
import AnswerItem from "@/components/AnswerItem";
import { Answer } from "@/types/answer";
import Head from "next/head";
import { getShortname } from "@/utils/client/siteConfig";
import { useSudo } from "@/contexts/SudoContext";
import { queryFetch } from "@/utils/client/reactQueryConfig";
import ReactMarkdown from "react-markdown";
import gfm from "remark-gfm";
import { Components } from "react-markdown";
import { logEvent } from "@/utils/client/analytics";

interface SingleAnswerProps {
  siteConfig: SiteConfig | null;
}

const SingleAnswer = ({ siteConfig }: SingleAnswerProps) => {
  const router = useRouter();
  const { answerId } = router.query;

  // All hooks must be called before any conditional returns
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const { isSudoUser } = useSudo();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Add ref to track initial load
  const initialLoadRef = useRef(true);
  // Check if user is admin or superuser (for login-required sites)
  const [isAdminOrSuperuser, setIsAdminOrSuperuser] = useState(false);

  // Check admin/superuser status for login-required sites
  useEffect(() => {
    const checkAdminStatus = async () => {
      if (!siteConfig?.requireLogin) return;

      // Check sessionStorage cache first
      const cachedRole = sessionStorage.getItem("userRole");
      if (cachedRole) {
        try {
          const { role, timestamp } = JSON.parse(cachedRole);
          // Cache valid for 1 hour
          if (Date.now() - timestamp < 60 * 60 * 1000) {
            setIsAdminOrSuperuser(role === "admin" || role === "superuser");
            return;
          }
        } catch {
          // Invalid cache, continue to fetch
        }
      }

      try {
        const response = await queryFetch("/api/profile");
        if (response.ok) {
          const data = await response.json();
          const role = (data?.role as string)?.toLowerCase() || "user";
          setIsAdminOrSuperuser(role === "admin" || role === "superuser");
          // Cache the result
          sessionStorage.setItem("userRole", JSON.stringify({ role, timestamp: Date.now() }));
        }
      } catch (error) {
        console.error("Failed to check admin status:", error);
      }
    };

    checkAdminStatus();
  }, [siteConfig?.requireLogin]);

  // Redirect to new share URL format
  useEffect(() => {
    if (router.isReady && answerId && typeof answerId === "string") {
      router.replace(`/share/${answerId}`);
    }
  }, [router.isReady, answerId, router]);

  // Custom link component to handle GETHUMAN links, similar to TruncatedMarkdown
  const LinkComponent: Components["a"] = ({ href, children, ...props }) => {
    if (siteConfig?.siteId === "ananda-public" && href === "GETHUMAN") {
      return (
        <a href="https://www.ananda.org/contact-us/" {...props}>
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  };

  // Fetch the answer data when the component mounts or answerId changes
  useEffect(() => {
    const fetchAnswer = async () => {
      if (!answerId) return;

      setIsLoading(true);
      setError(null);

      try {
        // Use regular fetch since viewing answers doesn't require authentication
        const response = await fetch(`/api/answers?answerIds=${answerId}`);

        if (response.status === 404) {
          setNotFound(true);
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || "Failed to fetch answer");
        }

        const data = await response.json();
        if (data && data.length > 0) {
          setAnswer(data[0]);
        } else {
          setNotFound(true);
        }
      } catch (error) {
        console.error("Error fetching answer:", error);
        setError(error instanceof Error ? error.message : "Failed to load answer");
      } finally {
        setIsLoading(false);
      }
    };

    if (answerId) {
      fetchAnswer();
    }
  }, [answerId]);

  // Scroll the main answer item into view only on initial load
  useEffect(() => {
    if (answer && initialLoadRef.current) {
      // Use a timeout to ensure the DOM is updated after state change
      const timer = setTimeout(() => {
        const mainAnswerElement = document.getElementById("main-answer-item");
        if (mainAnswerElement) {
          mainAnswerElement.scrollIntoView({
            behavior: "smooth",
            block: "start", // Changed to 'start' for better UX
          });
        }
        // Set initial load to false after first scroll
        initialLoadRef.current = false;
      }, 150); // Delay to allow rendering

      return () => clearTimeout(timer); // Cleanup timeout
    }
  }, [answer]); // Still depends on answer, but now checks initialLoadRef

  // Show loading while redirecting - early return after all hooks
  if (!router.isReady || (answerId && typeof answerId === "string")) {
    return (
      <Layout siteConfig={siteConfig}>
        <div className="flex justify-center items-center h-screen">
          <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"></div>
          <p className="text-lg text-gray-600 ml-4">Redirecting...</p>
        </div>
      </Layout>
    );
  }

  // Handle copying the answer link to clipboard
  const handleCopyLink = () => {
    const url = `${window.location.origin}/share/${answerId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      logEvent("copy_link", "Engagement", `Answer ID: ${answerId}`);
    });
  };

  // Handle answer deletion (admin functionality)
  const handleDelete = async (answerId: string) => {
    if (confirm("Are you sure you want to delete this answer?")) {
      try {
        // Use queryFetch instead of fetch to add JWT authentication
        const response = await queryFetch(`/api/answers?answerId=${answerId}`, {
          method: "DELETE",
        });

        if (!response.ok) {
          const responseData = await response.json();
          throw new Error("Failed to delete answer (" + responseData.message + ")");
        }

        router.push("/answers");
        logEvent("delete_answer", "Admin", answerId);
      } catch (error) {
        console.error("Error deleting answer:", error);
        alert("Failed to delete answer. Please try again.");
      }
    }
  };

  // Render "not found" message if the answer doesn't exist
  if (notFound) {
    return (
      <Layout siteConfig={siteConfig}>
        <div className="flex justify-center items-center h-screen">
          <p className="text-lg text-gray-600">Answer not found.</p>
        </div>
      </Layout>
    );
  }

  // Show error message if there was an error fetching the answer
  if (error) {
    return (
      <Layout siteConfig={siteConfig}>
        <div className="flex flex-col justify-center items-center h-screen">
          <p className="text-lg text-red-600 mb-4">Error: {error}</p>
          <button onClick={() => router.push("/answers")} className="bg-blue-500 text-white px-4 py-2 rounded-md">
            Go Back to All Answers
          </button>
        </div>
      </Layout>
    );
  }

  // Render loading spinner while fetching the answer
  if (isLoading || !answer) {
    return (
      <Layout siteConfig={siteConfig}>
        <div className="flex justify-center items-center h-screen">
          <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-blue-600"></div>
          <p className="text-lg text-gray-600 ml-4">Loading...</p>
        </div>
      </Layout>
    );
  }

  // Render the answer details
  return (
    <Layout siteConfig={siteConfig}>
      <Head>
        <title>
          {getShortname(siteConfig)}: {answer?.question?.substring(0, 150)}
        </title>
      </Head>
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
        {/* Render Conversation History if available */}
        {answer?.history && Array.isArray(answer.history) && answer.history.length > 0 && (
          <div className="mb-8 p-4 border border-gray-200 rounded-lg bg-gray-50">
            <h2 className="text-lg font-semibold mb-3 text-gray-700">Conversation History</h2>
            <div className="space-y-3">
              {answer.history.map((turn: { role: string; content: string }, index: number) => (
                <div
                  key={index}
                  className={`p-3 rounded-md ${
                    turn.role === "user" ? "bg-blue-50 text-blue-900" : "bg-green-50 text-green-900"
                  }`}
                >
                  <span className="font-medium capitalize">{turn.role}:</span>{" "}
                  <ReactMarkdown
                    remarkPlugins={[gfm]}
                    className="mt-1 prose prose-sm max-w-none text-gray-800"
                    components={{
                      a: LinkComponent, // Use the custom link handler
                    }}
                  >
                    {typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)}
                  </ReactMarkdown>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Render Main Answer */}
        {answer && (
          // Add id here for scrolling
          <div id="main-answer-item">
            <AnswerItem
              answer={answer}
              handleCopyLink={handleCopyLink}
              handleDelete={handleDelete}
              linkCopied={linkCopied ? answer.id : null}
              isSudoUser={isSudoUser}
              isAdminOrSuperuser={isAdminOrSuperuser}
              isFullPage={true}
              siteConfig={siteConfig}
            />
          </div>
        )}
      </div>
    </Layout>
  );
};

export default SingleAnswer;

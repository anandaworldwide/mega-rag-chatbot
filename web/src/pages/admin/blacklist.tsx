import React, { useCallback, useEffect, useState } from "react";
import Head from "next/head";
import type { GetServerSideProps, NextApiRequest } from "next";
import { isSuperuserPageAllowed } from "@/utils/server/adminPageGate";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";
import { AdminLayout } from "@/components/AdminLayout";
import { getToken } from "@/utils/client/tokenManager";

interface BlacklistPageProps {
  siteConfig: SiteConfig | null;
}

const MAX_LENGTH = 500_000;

export default function AdminBlacklistPage({ siteConfig }: BlacklistPageProps) {
  const [text, setText] = useState("");
  const [initialText, setInitialText] = useState("");
  const [emailCount, setEmailCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [validationErrors, setValidationErrors] = useState<{ line: number; content: string; reason: string }[]>([]);

  const isDirty = text !== initialText;

  const loadBlacklist = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const token = await getToken();
      if (!token) {
        setMessageType("error");
        setMessage("Not authenticated");
        setLoading(false);
        return;
      }
      const res = await fetch("/api/admin/blacklist", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setMessageType("error");
        setMessage(data.error || "Failed to load blacklist");
        setLoading(false);
        return;
      }
      const t = typeof data.text === "string" ? data.text : "";
      setText(t);
      setInitialText(t);
      setEmailCount(typeof data.emailCount === "number" ? data.emailCount : 0);
      setUpdatedAt(typeof data.updatedAt === "string" ? data.updatedAt : null);
    } catch {
      setMessageType("error");
      setMessage("Failed to load blacklist");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBlacklist();
  }, [loadBlacklist]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    setValidationErrors([]);
    try {
      const token = await getToken();
      if (!token) {
        setMessageType("error");
        setMessage("Not authenticated");
        setSaving(false);
        return;
      }
      const res = await fetch("/api/admin/blacklist", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessageType("error");
        setMessage(data.error || "Save failed");
        if (Array.isArray(data.details)) {
          setValidationErrors(data.details);
        }
        setSaving(false);
        return;
      }
      const savedText = typeof data.text === "string" ? data.text : "";
      setText(savedText);
      setInitialText(savedText);
      setEmailCount(typeof data.emailCount === "number" ? data.emailCount : 0);
      setUpdatedAt(new Date().toISOString());
      setMessageType("success");
      setMessage("Blacklist saved.");
    } catch {
      setMessageType("error");
      setMessage("Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head>
        <title>Admin · Email blacklist</title>
      </Head>
      <AdminLayout siteConfig={siteConfig} pageTitle="Email blacklist" superuserOnly>
        <div className="max-w-4xl space-y-4">
          <p className="text-sm text-gray-600">
            One email per line. Lines starting with <code className="bg-gray-100 px-1 rounded">#</code> are comments.
            Empty lines are ignored.
          </p>
          {updatedAt && (
            <p className="text-xs text-gray-500">Last loaded from storage: {new Date(updatedAt).toLocaleString()}</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-gray-700">
              <strong>{emailCount}</strong> blacklisted {emailCount === 1 ? "address" : "addresses"} (non-comment lines)
            </span>
            <button
              type="button"
              onClick={() => void loadBlacklist()}
              disabled={loading || saving}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={loading || saving || !isDirty}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {isDirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
          </div>
          {message && (
            <div
              className={`text-sm px-3 py-2 rounded-md ${
                messageType === "success" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
              }`}
            >
              {message}
            </div>
          )}
          {validationErrors.length > 0 && (
            <div className="text-sm bg-red-50 text-red-800 px-3 py-2 rounded-md">
              <p className="font-semibold mb-1">Fix the following lines:</p>
              <ul className="list-disc list-inside space-y-1">
                {validationErrors.slice(0, 20).map((err) => (
                  <li key={err.line}>
                    Line {err.line}: {err.reason}
                    {err.content.trim() && <code className="bg-red-100 px-1 ml-1 rounded">{err.content}</code>}
                  </li>
                ))}
                {validationErrors.length > 20 && (
                  <li>…and {validationErrors.length - 20} more.</li>
                )}
              </ul>
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={24}
            maxLength={MAX_LENGTH}
            disabled={loading}
            className="w-full font-mono text-sm border border-gray-300 rounded-md p-3 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder={"user@example.com\n# comment\nother@example.com"}
            spellCheck={false}
          />
          <p className="text-xs text-gray-500">
            {text.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()} characters
          </p>
        </div>
      </AdminLayout>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<BlacklistPageProps> = async ({ req }) => {
  try {
    const siteConfig = await loadSiteConfig();
    if (!siteConfig?.requireLogin) {
      return {
        redirect: {
          destination: "/unauthorized",
          permanent: false,
        },
      };
    }
    const isAllowed = await isSuperuserPageAllowed(req as NextApiRequest, undefined as any, siteConfig);
    if (!isAllowed) {
      return {
        redirect: {
          destination: "/unauthorized",
          permanent: false,
        },
      };
    }
    return { props: { siteConfig } };
  } catch (error) {
    console.error("Failed to load admin blacklist page:", error);
    return {
      redirect: {
        destination: "/unauthorized",
        permanent: false,
      },
    };
  }
};

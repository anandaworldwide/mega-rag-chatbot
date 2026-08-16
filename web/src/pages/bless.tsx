import { useState } from "react";
import Link from "next/link";
import { useSudo } from "@/contexts/SudoContext";
import validator from "validator";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import { GetServerSideProps } from "next";
import { SiteConfig } from "@/types/siteConfig";
import { loadSiteConfig } from "@/utils/server/loadSiteConfig";

interface SudoPageProps {
  siteConfig: SiteConfig | null;
}

const SudoPage: React.FC<SudoPageProps> = ({ siteConfig }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { isSudoUser, checkSudoStatus } = useSudo();

  const validatePassword = (password: string) => {
    if (!validator.isLength(password, { min: 8, max: 100 })) {
      return "Password must be between 8 and 100 characters";
    }
    return null;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const validationError = validatePassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      const response = await fetchWithAuth("/api/sudoCookie", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "An error occurred");
      }
      checkSudoStatus();
    } catch (error) {
      setError(error instanceof Error ? error.message : "An error occurred");
    }
  };

  const handleRemoveBlessed = async () => {
    try {
      const response = await fetchWithAuth("/api/sudoCookie", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        throw new Error("Failed to remove blessed status");
      }
      checkSudoStatus();
    } catch (error) {
      setError(error instanceof Error ? error.message : "An error occurred");
    }
  };

  // Show informational message for sites that require login
  if (siteConfig?.requireLogin) {
    return (
      <div className="flex flex-col justify-center items-center h-screen max-w-2xl mx-auto px-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-800 mb-6">Blessing Not Available</h1>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
            <p className="text-lg text-gray-700 mb-4">
              The blessing system is not relevant for this site because it uses user login authentication.
            </p>
            <p className="text-gray-600">
              Admin access is managed through user roles (admin/superuser) rather than the blessing cookie system.
            </p>
          </div>
          <Link href="/" className="inline-flex items-center text-blue-600 hover:text-blue-800 font-medium">
            <span className="material-icons text-sm mr-1">arrow_back</span>
            Return to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col justify-center items-center h-screen">
      <p className="text-lg text-gray-600 mb-4">{isSudoUser ? "You are Blessed!" : "You are not blessed"}</p>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <form onSubmit={handleSubmit} className="mb-4">
        <label htmlFor="bless-password" className="sr-only">
          Admin password
        </label>
        <input
          id="bless-password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter password"
          aria-label="Admin password"
          autoComplete="current-password"
          className="border p-2 mb-2"
          minLength={8}
          maxLength={100}
        />
        <button type="submit" className="bg-blue-500 text-white p-2">
          Submit
        </button>
      </form>
      <Link href="/" className="text-blue-500 hover:underline mb-4">
        Go to Home
      </Link>
      <a href="#" onClick={handleRemoveBlessed} className="text-blue-500 hover:underline">
        Remove Blessed Cookie
      </a>
    </div>
  );
};

export const getServerSideProps: GetServerSideProps<SudoPageProps> = async () => {
  try {
    const siteConfig = await loadSiteConfig();
    return {
      props: {
        siteConfig,
      },
    };
  } catch (error) {
    console.error("Failed to load site config for bless page:", error);
    return {
      props: {
        siteConfig: null,
      },
    };
  }
};

export default SudoPage;

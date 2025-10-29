import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./src/utils/server/loadEnv.js";

// Only load from .env file in development
if (process.env.NODE_ENV === "development") {
  loadEnv();
}

const site = process.env.SITE_ID || "default";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, "site-config", "config.json");
const configData = fs.readFileSync(configPath, "utf8");

// Parse allowed dev origins from environment variable (comma-separated)
const allowedDevOrigins = process.env.NEXT_PUBLIC_ALLOWED_DEV_ORIGINS
  ? process.env.NEXT_PUBLIC_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim())
  : undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(allowedDevOrigins && { allowedDevOrigins }),
  webpack: (config, { dev, isServer }) => {
    config.experiments = { ...config.experiments, topLevelAwait: true };

    // Ensure 'onnxruntime-node' is treated as external in the server build
    if (isServer) {
      config.externals = [...config.externals, "onnxruntime-node"];
    }

    if (dev && !isServer) {
      // Disable optimization in development mode if needed (check if necessary)
      // config.optimization = {
      //   ...config.optimization,
      //   splitChunks: false,
      // };
    }

    return config;
  },
  async rewrites() {
    // Ensure we have a valid base URL, defaulting to a relative path if not set
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "";

    return [
      {
        source: "/api/sudoCookie",
        destination: `${baseUrl}/api/sudoCookie`,
      },
    ];
  },
  env: {
    SITE_ID: site,
    SITE_CONFIG: configData,
  },
  images: {
    domains: ["www.crystalclarity.com"],
  },
  experimental: {
    // This is the correct way to handle external packages for server components/actions
    serverComponentsExternalPackages: ["onnxruntime-node"],
  },
};

export default nextConfig;

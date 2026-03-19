import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to get available sites from config
function getAvailableSites() {
  const configPath = path.join(__dirname, "..", "site-config", "config.json");
  try {
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    const sites = Object.keys(config).map((siteId) => ({
      id: siteId,
      name: config[siteId].name || config[siteId].shortname || siteId,
    }));

    // Swap jairam and crystal (indices 2 and 3)
    const jairamIndex = sites.findIndex((s) => s.id === "jairam");
    const crystalIndex = sites.findIndex((s) => s.id === "crystal");
    if (jairamIndex !== -1 && crystalIndex !== -1) {
      [sites[jairamIndex], sites[crystalIndex]] = [sites[crystalIndex], sites[jairamIndex]];
    }

    return sites;
  } catch (error) {
    console.error("Error reading site config:", error);
    return [];
  }
}

// Function to prompt user for site selection
function promptSiteSelection() {
  return new Promise((resolve) => {
    const sites = getAvailableSites();

    if (sites.length === 0) {
      console.error("No sites found in configuration.");
      process.exit(1);
    }

    console.log("\n📋 Available sites:\n");
    sites.forEach((site, index) => {
      console.log(`  ${index + 1}. ${site.name} (${site.id})`);
    });
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`Select a site (1-${sites.length}): `, (answer) => {
      rl.close();
      const selection = parseInt(answer.trim(), 10);

      if (isNaN(selection) || selection < 1 || selection > sites.length) {
        console.error(`\n❌ Invalid selection. Please choose a number between 1 and ${sites.length}.`);
        process.exit(1);
      }

      const selectedSite = sites[selection - 1];
      console.log(`\n✅ Selected: ${selectedSite.name} (${selectedSite.id})\n`);
      resolve(selectedSite.id);
    });
  });
}

// Main function
async function main() {
  // If site is provided as command line argument, use it directly
  let site = process.argv[2];

  // If no site provided, prompt user to select
  if (!site) {
    site = await promptSiteSelection();
  }

  const envFile = path.join(__dirname, "..", `.env.${site}`);

  // Load environment variables from site-specific file
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
    console.log(`Loaded environment from ${envFile}`);
  } else {
    console.warn(`Warning: ${envFile} not found. Using default .env`);
    dotenv.config();
  }

  // CRITICAL: Make sure SITE_ID is set
  process.env.SITE_ID = site;
  console.log(`Starting Next.js with SITE_ID: ${site}\n`);

  // Pass the environment to the spawned process
  const nextDev = spawn("next", ["dev", "--webpack", "-H", "0.0.0.0"], {
    stdio: "inherit",
    env: process.env,
  });

  nextDev.on("error", (err) => {
    console.error("Failed to start Next.js dev server:", err);
  });

  nextDev.on("close", (code) => {
    console.log(`Next.js dev server exited with code ${code}`);
  });
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

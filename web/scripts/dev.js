import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Full Next.js stdout/stderr tee; rotated when it exceeds this size. */
const DEV_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEV_LOG_PATH = path.join(__dirname, "..", "tmp", "dev.log");
const DEV_LOG_PREV_PATH = path.join(__dirname, "..", "tmp", "dev.log.1");

// Function to get available sites from config
function getAvailableSites() {
  const configPath = path.join(__dirname, "..", "site-config", "config.json");
  try {
    const configContent = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    const sites = Object.keys(config).map((siteId) => ({
      id: siteId,
      name: config[siteId].name || config[siteId].shortname || siteId,
      shortname: config[siteId].shortname || siteId,
    }));

    // Swap jairam and crystal (indices 2 and 3)
    const jairamIndex = sites.findIndex((s) => s.id === "jairam");
    const crystalIndex = sites.findIndex((s) => s.id === "crystal");
    if (jairamIndex !== -1 && crystalIndex !== -1) {
      [sites[jairamIndex], sites[crystalIndex]] = [sites[crystalIndex], sites[jairamIndex]];
    }

    // Default local dev site: Luca (ananda) is always option 1
    const lucaIndex = sites.findIndex((s) => s.id === "ananda");
    if (lucaIndex > 0) {
      const [luca] = sites.splice(lucaIndex, 1);
      sites.unshift(luca);
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

    const defaultLabel = sites[0].shortname || sites[0].name;
    rl.question(`Select a site (1-${sites.length}, Enter = ${defaultLabel}): `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      const selection = trimmed === "" ? 1 : parseInt(trimmed, 10);

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

/**
 * Tee child stdout/stderr to the terminal and a size-capped rotating log file.
 * Keeps at most ~2 × DEV_LOG_MAX_BYTES on disk (current + one previous).
 */
function createRotatingLogWriter() {
  const tmpDir = path.dirname(DEV_LOG_PATH);
  fs.mkdirSync(tmpDir, { recursive: true });

  let bytesWritten = fs.existsSync(DEV_LOG_PATH) ? fs.statSync(DEV_LOG_PATH).size : 0;
  let logFd = fs.openSync(DEV_LOG_PATH, "a");

  function rotateIfNeeded(incomingBytes) {
    if (bytesWritten + incomingBytes <= DEV_LOG_MAX_BYTES) {
      return;
    }
    fs.closeSync(logFd);
    if (fs.existsSync(DEV_LOG_PREV_PATH)) {
      fs.unlinkSync(DEV_LOG_PREV_PATH);
    }
    if (fs.existsSync(DEV_LOG_PATH)) {
      fs.renameSync(DEV_LOG_PATH, DEV_LOG_PREV_PATH);
    }
    logFd = fs.openSync(DEV_LOG_PATH, "w");
    bytesWritten = 0;
  }

  function write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    rotateIfNeeded(buf.length);
    fs.writeSync(logFd, buf);
    bytesWritten += buf.length;
  }

  function close() {
    try {
      fs.closeSync(logFd);
    } catch {
      // already closed
    }
  }

  return { write, close, path: DEV_LOG_PATH };
}

function teeStream(readable, writeTerminal, logWriter) {
  readable.on("data", (chunk) => {
    writeTerminal(chunk);
    logWriter.write(chunk);
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
  console.log(`Starting Next.js with SITE_ID: ${site}`);

  const logWriter = createRotatingLogWriter();
  console.log(
    `Logging to ${logWriter.path} (rotate at ${Math.round(DEV_LOG_MAX_BYTES / (1024 * 1024))}MB; previous → dev.log.1)`
  );
  console.log(`TTFB metrics JSONL: ${path.join(__dirname, "..", "tmp", "ttfb-metrics.jsonl")}\n`);

  // Pass the environment to the spawned process; pipe stdout/stderr so we can tee.
  const nextDev = spawn("next", ["dev", "--webpack", "-H", "0.0.0.0"], {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  if (nextDev.stdout) {
    teeStream(nextDev.stdout, (chunk) => process.stdout.write(chunk), logWriter);
  }
  if (nextDev.stderr) {
    teeStream(nextDev.stderr, (chunk) => process.stderr.write(chunk), logWriter);
  }

  const forwardSignal = (signal) => {
    if (!nextDev.killed) {
      nextDev.kill(signal);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  nextDev.on("error", (err) => {
    console.error("Failed to start Next.js dev server:", err);
    logWriter.close();
  });

  nextDev.on("close", (code) => {
    logWriter.close();
    console.log(`Next.js dev server exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

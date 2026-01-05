/*
 * Script to populate a newsletter queue with test items for volume testing
 *
 * Prerequisites:
 *   1. Create a newsletter via the admin panel (Admin > Newsletters > Create Newsletter)
 *   2. Note the newsletter ID from the URL or newsletter details page
 *
 * Steps:
 *   1. Create a newsletter in the admin panel with your desired subject/content
 *   2. Copy the newsletter ID (found in the URL or newsletter details)
 *   3. Run this script with --site, newsletter ID, desired count, and your Gmail username
 *   4. Process batches via Admin > Newsletters > Newsletter Queue Processor
 *
 * Usage:
 *   npx tsx scripts/populateNewsletterQueue.ts --site <siteId> <newsletterId> <count> <gmailUsername>
 *
 * Example:
 *   npx tsx scripts/populateNewsletterQueue.ts --site ananda abc123def456 200 myusername
 *
 * This will create 200 test queue items with emails:
 *   myusername+test1@gmail.com, myusername+test2@gmail.com, ..., myusername+test200@gmail.com
 *
 * Note: All emails will be delivered to your Gmail inbox (Gmail's plus addressing feature).
 *       You can filter them using "to:myusername+test" in Gmail search.
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import readline from "readline";
import firebase from "firebase-admin";

// Hard-wired to dev environment for testing
const NEWSLETTERS_COLLECTION = "dev_newsletters";

// Script is run from web/ directory, so project root is one level up
const projectRoot = path.join(process.cwd(), "..");

function loadEnvironmentDirectly(site: string) {
  const envFile = path.join(projectRoot, `.env.${site}`);
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
    console.log(`Loaded environment from ${envFile}`);
  } else {
    console.warn(`Warning: ${envFile} not found. Using current process env.`);
  }
}

async function ensureFirebase(): Promise<firebase.firestore.Firestore> {
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!creds) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS env var is not set. Provide Firebase service account JSON string or file path."
    );
  }

  let json: Record<string, any>;
  try {
    // Try parsing as JSON first
    json = JSON.parse(creds);
  } catch (e) {
    // If parsing fails, try treating as file path
    if (fs.existsSync(creds)) {
      const fileContents = fs.readFileSync(creds, "utf8");
      json = JSON.parse(fileContents);
    } else {
      throw new Error(`Invalid GOOGLE_APPLICATION_CREDENTIALS: not valid JSON and file does not exist: ${creds}`);
    }
  }

  if (!firebase.apps.length) {
    firebase.initializeApp({ credential: firebase.credential.cert(json) });
  }
  return firebase.firestore();
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function confirmEmailAddress(gmailUsername: string, count: number, existingCount: number): Promise<boolean> {
  const firstEmail = `${gmailUsername}+test${existingCount + 1}@gmail.com`;
  const lastEmail = `${gmailUsername}+test${existingCount + count}@gmail.com`;

  console.log("\n⚠️  CONFIRMATION REQUIRED");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`You are about to create ${count} test queue items with emails:`);
  console.log(`   First: ${firstEmail}`);
  console.log(`   Last:  ${lastEmail}`);
  console.log(`\nAll emails will be sent to: ${gmailUsername}@gmail.com`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const answer = await ask("Is this Gmail address correct? (yes/no): ");
  const normalized = answer.toLowerCase().trim();

  if (normalized === "yes" || normalized === "y") {
    return true;
  }

  console.log("\n❌ Confirmation denied. Aborting.");
  return false;
}

async function populateTestQueue(
  db: firebase.firestore.Firestore,
  newsletterId: string,
  count: number,
  gmailUsername: string
) {
  console.log(`📬 Populating newsletter queue ${newsletterId} with ${count} test items...`);

  // Verify newsletter exists
  const newsletterRef = db.collection(NEWSLETTERS_COLLECTION).doc(newsletterId);
  const newsletterDoc = await newsletterRef.get();

  if (!newsletterDoc.exists) {
    throw new Error(`Newsletter ${newsletterId} does not exist. Create it first via the admin panel.`);
  }

  const newsletterData = newsletterDoc.data();
  console.log(`   Newsletter: "${newsletterData?.subject || "Unknown"}"`);

  // Check existing queue items
  const existingQuery = db
    .collection(`${NEWSLETTERS_COLLECTION}/${newsletterId}/queueItems`)
    .where("status", "==", "pending");
  const existingSnapshot = await existingQuery.get();
  const existingCount = existingSnapshot.size;

  console.log(`   Existing pending items: ${existingCount}`);
  console.log(`   Adding ${count} new test items...`);
  console.log(`   Gmail username: ${gmailUsername}`);

  // Confirm email address before proceeding
  const confirmed = await confirmEmailAddress(gmailUsername, count, existingCount);
  if (!confirmed) {
    process.exit(0); // Exit cleanly - user already saw the denial message
  }

  // Create queue items in batches (Firestore batch limit is 500)
  const batchSize = 500;
  let added = 0;

  for (let i = 0; i < count; i += batchSize) {
    const batch = db.batch();
    const batchCount = Math.min(batchSize, count - i);

    for (let j = 0; j < batchCount; j++) {
      const itemNumber = existingCount + i + j + 1;
      const queueRef = db.collection(`${NEWSLETTERS_COLLECTION}/${newsletterId}/queueItems`).doc();

      batch.set(queueRef, {
        email: `${gmailUsername}+test${itemNumber}@gmail.com`,
        subject: newsletterData?.subject || "Test Newsletter",
        content:
          newsletterData?.content || "# Test Newsletter Content\n\nThis is a test newsletter for volume testing.",
        ctaUrl: newsletterData?.ctaUrl || null,
        ctaText: newsletterData?.ctaText || null,
        firstName: `Test${itemNumber}`,
        lastName: "User",
        status: "pending",
        attempts: 0,
        createdAt: firebase.firestore.Timestamp.now(),
      });
    }

    await batch.commit();
    added += batchCount;
    console.log(`   ✓ Added ${added}/${count} items...`);
  }

  // Update newsletter metadata
  await newsletterRef.update({
    totalQueued: firebase.firestore.FieldValue.increment(count),
    status: "queued",
  });

  console.log(`\n✅ Successfully added ${count} test queue items!`);
  console.log(`   Newsletter ID: ${newsletterId}`);
  console.log(`   Total pending items: ${existingCount + count}`);
  console.log(
    `   Test emails: ${gmailUsername}+test${existingCount + 1}@gmail.com through ${gmailUsername}+test${existingCount + count}@gmail.com`
  );
}

// Main execution
const args = process.argv.slice(2);

// Parse arguments
const getArgVal = (name: string): string | undefined => {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split("=")[1];
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  return undefined;
};

const site = getArgVal("site");
if (!site) {
  console.error("Error: --site argument is required. Use --site ananda, --site crystal, etc.");
  console.error(
    "\nUsage: npx tsx scripts/populateNewsletterQueue.ts --site <siteId> <newsletterId> <count> <gmailUsername>"
  );
  console.error("\nExample:");
  console.error("  npx tsx scripts/populateNewsletterQueue.ts --site ananda abc123def456 200 myusername");
  process.exit(1);
}

// Load environment from site-specific .env file
loadEnvironmentDirectly(site);

// Parse remaining arguments (newsletterId, count, gmailUsername)
// Filter out --site flag and its value, or --site=value format
const positionalArgs = args.filter((arg, idx) => {
  // Skip --site flag
  if (arg === "--site") return false;
  // Skip the value after --site
  if (idx > 0 && args[idx - 1] === "--site") return false;
  // Skip --site=value format
  if (arg.startsWith("--site=")) return false;
  // Skip other flags
  if (arg.startsWith("--")) return false;
  return true;
});
if (positionalArgs.length < 3) {
  console.error(
    "Usage: npx tsx scripts/populateNewsletterQueue.ts --site <siteId> <newsletterId> <count> <gmailUsername>"
  );
  console.error("\nExample:");
  console.error("  npx tsx scripts/populateNewsletterQueue.ts --site ananda abc123def456 200 myusername");
  console.error(
    "\nNote: gmailUsername should be the part before @gmail.com (e.g., 'myusername' for myusername@gmail.com)"
  );
  process.exit(1);
}

const [newsletterId, countStr, gmailUsername] = positionalArgs;
const count = parseInt(countStr, 10);

if (isNaN(count) || count <= 0) {
  console.error(`Invalid count: ${countStr}. Must be a positive number.`);
  process.exit(1);
}

if (!gmailUsername || gmailUsername.includes("@")) {
  console.error(
    `Invalid Gmail username: ${gmailUsername}. Should be just the username part (e.g., 'myusername' not 'myusername@gmail.com')`
  );
  process.exit(1);
}

// Initialize Firebase and run
ensureFirebase()
  .then((db) => populateTestQueue(db, newsletterId, count, gmailUsername))
  .then(() => {
    console.log("\n✨ Done!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  });

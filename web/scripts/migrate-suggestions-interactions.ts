/**
 * Migration script to move suggestion_interactions data to environment-prefixed collections
 *
 * Migrates all existing data from `suggestion_interactions` to `prod_suggestions_interactions`
 * (user confirmed all existing data is production data)
 *
 * Usage: npx tsx scripts/migrate-suggestions-interactions.ts --site <site-name> [--dry-run]
 * Example: npx tsx scripts/migrate-suggestions-interactions.ts --site ananda --dry-run
 */

import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

// Get directory path for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Site-specific environment loading function
function loadEnvironmentForSite(site: string) {
  // Go up to project root from web/scripts/
  const envPath = path.join(__dirname, "..", "..", `.env.${site}`);
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    console.error(`Failed to load environment file: ${envPath}`);
    console.error(result.error.message);
    process.exit(1);
  }

  console.log(`Loaded environment from: ${envPath}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const siteIndex = args.indexOf("--site");
const dryRunIndex = args.indexOf("--dry-run");

if (siteIndex === -1 || siteIndex + 1 >= args.length) {
  console.error("Usage: npx tsx scripts/migrate-suggestions-interactions.ts --site <site-name> [--dry-run]");
  console.error("Example: npx tsx scripts/migrate-suggestions-interactions.ts --site ananda --dry-run");
  process.exit(1);
}

const site = args[siteIndex + 1];
const dryRun = dryRunIndex !== -1;

// Load site-specific environment
loadEnvironmentForSite(site);

// Now import Firebase after environment is loaded
import firebase from "firebase-admin";

// Initialize Firebase directly in the migration script
let db: firebase.firestore.Firestore;

try {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!serviceAccountJson) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS environment variable is not set");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  if (!firebase.apps.length) {
    firebase.initializeApp({
      credential: firebase.credential.cert(serviceAccount),
    });
  }

  db = firebase.firestore();
} catch (error) {
  console.error("Failed to initialize Firebase:", error);
  process.exit(1);
}

// Collection names
const SOURCE_COLLECTION = "suggestion_interactions";
const TARGET_COLLECTION = "prod_suggestions_interactions";

// Helper function to prompt for confirmation
function promptConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "yes" || answer.toLowerCase() === "y");
    });
  });
}

async function migrateSuggestionsInteractions() {
  console.log(`\n🚀 Suggestions Interactions Migration Script`);
  console.log("===========================================");
  console.log(`Site: ${site}`);
  console.log(`Source collection: ${SOURCE_COLLECTION}`);
  console.log(`Target collection: ${TARGET_COLLECTION}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no changes will be made)" : "LIVE UPDATE"}`);

  // Check if db is available
  if (!db) {
    console.error("Firestore database not initialized, cannot run migration");
    console.error("Make sure GOOGLE_APPLICATION_CREDENTIALS and other Firebase env vars are set");
    process.exit(1);
  }

  try {
    // Check if source collection exists and get count
    const sourceRef = db.collection(SOURCE_COLLECTION);
    const sourceSnapshot = await sourceRef.get();

    console.log(`\n📊 Source collection statistics:`);
    console.log(`   Total documents: ${sourceSnapshot.size}`);

    if (sourceSnapshot.size === 0) {
      console.log("\n✅ No documents to migrate. Source collection is empty.");
      return;
    }

    // Show sample documents
    const sampleDocs = sourceSnapshot.docs.slice(0, 3);
    console.log(`\n📋 Sample documents (first 3):`);
    sampleDocs.forEach((doc, index) => {
      const data = doc.data();
      console.log(`   ${index + 1}. ID: ${doc.id}`);
      console.log(`      convId: ${data.convId || "N/A"}`);
      console.log(`      suggestionId: ${data.suggestionId || "N/A"}`);
      console.log(`      type: ${data.type || "N/A"}`);
      console.log(`      timestamp: ${data.timestamp?.toDate?.() || data.timestamp || "N/A"}`);
    });

    // Check if target collection already has data
    const targetRef = db.collection(TARGET_COLLECTION);
    const targetSnapshot = await targetRef.get();
    console.log(`\n📊 Target collection statistics:`);
    console.log(`   Existing documents: ${targetSnapshot.size}`);

    if (targetSnapshot.size > 0 && !dryRun) {
      console.warn(`\n⚠️  WARNING: Target collection already has ${targetSnapshot.size} documents!`);
      const proceed = await promptConfirmation("Do you want to continue? This will add to existing data (not replace)");
      if (!proceed) {
        console.log("Migration cancelled by user");
        return;
      }
    }

    if (dryRun) {
      console.log(`\n🧪 DRY RUN MODE - Would migrate ${sourceSnapshot.size} documents`);
      console.log(`   Would copy all documents from ${SOURCE_COLLECTION} to ${TARGET_COLLECTION}`);
      console.log("\n✅ Dry run completed - no database changes made");
      console.log("\nTo perform the actual migration, run without --dry-run flag");
      return;
    }

    // Confirm before proceeding with actual migration
    console.log(`\n⚠️  LIVE MODE - This will migrate ${sourceSnapshot.size} documents`);
    const confirm = await promptConfirmation("Are you sure you want to proceed?");
    if (!confirm) {
      console.log("Migration cancelled by user");
      return;
    }

    // Process documents in batches of 500 (Firestore batch limit)
    const batchSize = 500;
    let processedCount = 0;
    let errorCount = 0;
    const totalDocs = sourceSnapshot.docs.length;

    console.log(`\n🔄 Starting migration...`);

    for (let i = 0; i < totalDocs; i += batchSize) {
      const batch = db.batch();
      const batchDocs = sourceSnapshot.docs.slice(i, i + batchSize);

      batchDocs.forEach((doc) => {
        // Copy document data to target collection
        // Preserve the original document ID
        const targetDocRef = targetRef.doc(doc.id);
        batch.set(targetDocRef, doc.data(), { merge: true });
      });

      try {
        await batch.commit();
        processedCount += batchDocs.length;
        console.log(`   ✅ Processed ${processedCount}/${totalDocs} documents`);
      } catch (error) {
        console.error(`   ❌ Error processing batch starting at index ${i}:`, error);
        errorCount += batchDocs.length;
      }
    }

    console.log(`\n✅ Migration completed!`);
    console.log(`   Successfully migrated: ${processedCount} documents`);
    if (errorCount > 0) {
      console.log(`   Errors: ${errorCount} documents`);
    }

    // Verify the migration
    console.log(`\n🔍 Verifying migration...`);
    const verifySnapshot = await targetRef.get();
    const verifyCount = verifySnapshot.size;

    console.log(`   Target collection now has: ${verifyCount} documents`);
    console.log(`   Expected: ${sourceSnapshot.size} documents`);

    if (verifyCount >= sourceSnapshot.size) {
      console.log(`\n✅ Verification passed: All documents migrated successfully`);
      console.log(`\n📝 Next steps:`);
      console.log(`   1. Monitor the application for 24-48 hours`);
      console.log(`   2. Verify no errors related to suggestion_interactions collection`);
      console.log(`   3. After confirmation, manually delete the ${SOURCE_COLLECTION} collection`);
    } else {
      console.warn(
        `\n⚠️  Warning: Expected ${sourceSnapshot.size} documents but found ${verifyCount} in target collection`
      );
      console.log(`   This may be due to duplicate document IDs or other issues`);
      console.log(`   Please review the migration before deleting the source collection`);
    }
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run the migration
migrateSuggestionsInteractions()
  .then(() => {
    console.log("\nMigration script completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration script failed:", error);
    process.exit(1);
  });

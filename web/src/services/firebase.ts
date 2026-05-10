// import { isDevelopment } from '@/utils/env';
import firebase from "firebase-admin";
import { initializeFirestore } from "firebase-admin/firestore";

// Check if we're in a build environment
const isBuildTime = process.env.NODE_ENV === "production" && process.env.NEXT_PHASE === "phase-production-build";

// Initialize Firebase and export the Firestore database
let db: firebase.firestore.Firestore | null = null;

type FirebaseCredentialSummary = {
  siteId?: string;
  projectId?: string;
  clientEmail?: string;
  privateKeyId?: string;
};

let credentialSummary: FirebaseCredentialSummary = {
  siteId: process.env.SITE_ID,
};

export function getFirebaseCredentialSummary(): FirebaseCredentialSummary {
  return { ...credentialSummary, siteId: process.env.SITE_ID };
}

// Skip initialization during build time
if (isBuildTime) {
  console.warn("Skipping Firebase initialization during build time");
} else if (!firebase.apps.length) {
  try {
    const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    // Validate credentials
    if (typeof serviceAccountJson !== "string") {
      if (serviceAccountJson === undefined) {
        throw new Error("The GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.");
      } else {
        console.error("Type of serviceAccountJson:", typeof serviceAccountJson);
        throw new Error("The GOOGLE_APPLICATION_CREDENTIALS environment variable is not a string.");
      }
    }

    // Parse the service account JSON - let SyntaxError throw for test scenarios
    const serviceAccount = JSON.parse(serviceAccountJson);
    credentialSummary = {
      siteId: process.env.SITE_ID,
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKeyId: serviceAccount.private_key_id,
    };

    // Check if this is just an empty JSON object (e.g., '{}' from GitHub Actions)
    // Only handle this case specifically for CI environments
    if (!serviceAccount || Object.keys(serviceAccount).length === 0) {
      console.warn("Empty Firebase credentials provided, skipping Firebase initialization");
      db = null;
    }
    // Check for required fields in the service account - throw if missing
    else {
      const requiredFields = ["type", "project_id", "private_key", "client_email"];
      const missingFields = requiredFields.filter((field) => !serviceAccount[field]);

      if (missingFields.length > 0) {
        throw new Error(`Firebase credentials missing required fields: ${missingFields.join(", ")}`);
      } else {
        const app = firebase.initializeApp({
          credential: firebase.credential.cert(serviceAccount),
        });

        // Initialize Firestore with preferRest to improve cold start times
        initializeFirestore(app, { preferRest: true });
        db = firebase.firestore();

        // if (isDevelopment()) {
        //   db.settings({
        //     host: 'localhost:8080',
        //     ssl: false,
        //   });
        // }
        // Firestore initialized
        if (process.env.NODE_ENV !== "production") {
          console.info("Firebase initialized", credentialSummary);
        }
      }
    }
  } catch (error) {
    console.error("Error initializing Firebase:", error);
    // Don't throw during build time
    if (!isBuildTime) {
      // Allow SyntaxError and other errors to propagate for test scenarios
      throw error;
    }
  }
} else {
  db = firebase.firestore();
}

export { db };

/**
 * Client-side Demo Mode Utilities
 *
 * Utilities for masking personally identifiable information (PII) in admin interfaces
 * when demo cookie is set. This allows safe demonstration of the admin interface
 * without exposing real user data.
 */

import Cookies from "js-cookie";

/**
 * Check if demo mode is enabled via demo cookie
 */
export function isDemoModeEnabled(): boolean {
  return Cookies.get("demo") === "true";
}

/**
 * Mask an email address for demo purposes
 * Converts "user@example.com" to "u***@e***.com"
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) {
    return email;
  }

  const [localPart, domain] = email.split("@");
  const [domainName, ...domainExtensions] = domain.split(".");

  const maskedLocal = localPart.length > 1 ? `${localPart[0]}***` : localPart;
  const maskedDomain = domainName.length > 1 ? `${domainName[0]}***` : domainName;
  const maskedExtension = domainExtensions.join(".");

  return `${maskedLocal}@${maskedDomain}.${maskedExtension}`;
}

/**
 * List of common first and last names for deterministic fake name generation
 */
const FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Avery",
  "Quinn",
  "Sage",
  "River",
  "Dakota",
  "Skyler",
  "Cameron",
  "Drew",
  "Parker",
  "Reese",
  "Blake",
  "Charlie",
  "Sam",
  "Pat",
  "Jamie",
  "Kendall",
  "Marley",
  "Phoenix",
  "Rowan",
  "Emerson",
  "Finley",
  "Harper",
  "Hayden",
  "Lennon",
];

const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Gonzalez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
  "Moore",
  "Jackson",
  "Martin",
  "Lee",
  "Perez",
  "Thompson",
  "White",
  "Harris",
  "Sanchez",
  "Clark",
  "Ramirez",
  "Lewis",
  "Robinson",
];

/**
 * Simple hash function to generate a deterministic number from a string
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a deterministic fake name based on UUID or email
 * Same UUID/email will always generate the same fake name
 */
export function generateFakeName(
  identifier: string | null | undefined,
  returnFirstOnly: boolean = false,
  returnLastOnly: boolean = false
): { firstName: string; lastName: string; fullName: string } {
  if (!identifier) {
    return { firstName: "Demo", lastName: "User", fullName: "Demo User" };
  }

  const hash = simpleHash(identifier);
  const firstNameIndex = hash % FIRST_NAMES.length;
  const lastNameIndex = Math.floor(hash / FIRST_NAMES.length) % LAST_NAMES.length;

  const firstName = FIRST_NAMES[firstNameIndex];
  const lastName = LAST_NAMES[lastNameIndex];

  if (returnFirstOnly) {
    return { firstName, lastName: "", fullName: firstName };
  }

  if (returnLastOnly) {
    return { firstName: "", lastName, fullName: lastName };
  }

  return { firstName, lastName, fullName: `${firstName} ${lastName}` };
}

/**
 * Apply demo mode transformations to a user object
 */
export function maskUserPII(user: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  uuid?: string | null;
  [key: string]: any;
}): typeof user {
  if (!isDemoModeEnabled()) {
    return user;
  }

  const identifier = user.uuid || user.email;
  const fakeName = generateFakeName(identifier);

  return {
    ...user,
    email: maskEmail(user.email),
    firstName: fakeName.firstName,
    lastName: fakeName.lastName,
  };
}

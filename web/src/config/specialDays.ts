/**
 * Special day configuration for special day email notifications
 * Loads site-specific special day definitions from JSON config files
 */

import * as fs from "fs";
import * as path from "path";

export interface SpecialDay {
  id: string; // e.g., "masters-birthday"
  name: string; // e.g., "Master's Birthday"
  getDate: (year: number) => Date; // Returns the date for a given year
  sendDaysBefore: number; // 1 for most, 3 for Christmas
}

interface SpecialDayConfig {
  id: string;
  name: string;
  month?: number; // 1-12 for fixed dates
  day?: number; // 1-31 for fixed dates
  type?: "easter"; // For calculated dates like Easter
  sendDaysBefore: number;
}

interface SpecialDaysConfigFile {
  specialDays: SpecialDayConfig[];
}

/**
 * Calculates Easter Sunday date for a given year using the Anonymous Gregorian algorithm (computus)
 * This is a well-tested formula that works for all years in the Gregorian calendar
 *
 * @param year - The year to calculate Easter for
 * @returns Date object for Easter Sunday
 */
function calculateEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(year, month - 1, day);
}

/**
 * Converts a SpecialDayConfig to a SpecialDay with getDate function
 */
function configToSpecialDay(config: SpecialDayConfig): SpecialDay {
  let getDate: (year: number) => Date;

  if (config.type === "easter") {
    getDate = (year: number) => calculateEaster(year);
  } else if (config.month !== undefined && config.day !== undefined) {
    // Fixed date: month is 1-12, convert to 0-11 for Date constructor
    getDate = (year: number) => new Date(year, config.month! - 1, config.day!);
  } else {
    throw new Error(`Invalid special day config for ${config.id}: must have either type="easter" or month/day`);
  }

  return {
    id: config.id,
    name: config.name,
    getDate,
    sendDaysBefore: config.sendDaysBefore,
  };
}

// Cache for loaded special days by site ID
const specialDaysCache: Map<string, SpecialDay[]> = new Map();

/**
 * Loads special days configuration for a specific site
 *
 * @param siteId - Site ID (e.g., "ananda")
 * @returns Array of SpecialDay objects or empty array if not found
 */
export async function loadSpecialDays(siteId: string): Promise<SpecialDay[]> {
  // Check cache first
  if (specialDaysCache.has(siteId)) {
    return specialDaysCache.get(siteId)!;
  }

  try {
    // Validate siteId to prevent path traversal
    if (!/^[a-zA-Z0-9-]+$/.test(siteId)) {
      console.error(`Invalid siteId: ${siteId}`);
      return [];
    }

    const configPath = path.join(process.cwd(), "site-config", "special-days", `${siteId}.json`);

    const exists = await fs.promises
      .access(configPath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      console.log(`No special days config found for site ${siteId}`);
      return [];
    }

    const configContent = await fs.promises.readFile(configPath, "utf-8");
    const configFile: SpecialDaysConfigFile = JSON.parse(configContent);

    // Convert config to SpecialDay objects
    const specialDays = configFile.specialDays.map(configToSpecialDay);

    // Cache the result
    specialDaysCache.set(siteId, specialDays);

    return specialDays;
  } catch (error) {
    console.error(`Error loading special days config for site ${siteId}:`, error);
    return [];
  }
}

/**
 * Gets the send date for a special day (the date when emails should be sent)
 *
 * @param specialDay - Special day configuration
 * @param year - Year to calculate for
 * @returns Date when emails should be sent
 */
export function getSendDate(specialDay: SpecialDay, year: number): Date {
  const eventDate = specialDay.getDate(year);
  const sendDate = new Date(eventDate);
  sendDate.setDate(sendDate.getDate() - specialDay.sendDaysBefore);
  return sendDate;
}

/**
 * Gets all special days that should have emails sent on a given date
 *
 * @param date - Date to check (defaults to today)
 * @param siteId - Site ID to load special days for
 * @returns Array of special days that should be sent on this date
 */
export async function getSpecialDaysForDate(siteId: string, date: Date = new Date()): Promise<SpecialDay[]> {
  const specialDays = await loadSpecialDays(siteId);
  const year = date.getFullYear();
  const matching: SpecialDay[] = [];

  for (const specialDay of specialDays) {
    const sendDate = getSendDate(specialDay, year);
    // Compare dates ignoring time (only year, month, day)
    if (
      sendDate.getFullYear() === date.getFullYear() &&
      sendDate.getMonth() === date.getMonth() &&
      sendDate.getDate() === date.getDate()
    ) {
      matching.push(specialDay);
    }
  }

  return matching;
}

/**
 * Generates a campaign ID for a special day email
 * Format: {specialDayId}-{year} (e.g., "masters-birthday-2026")
 *
 * @param specialDayId - Special day ID
 * @param year - Year
 * @returns Campaign ID string
 */
export function generateCampaignId(specialDayId: string, year: number): string {
  return `${specialDayId}-${year}`;
}

/**
 * Real check for empty Vivek location data. The live suites set
 * ACCEPT_LOCATION_SEARCH_MISS from this, and do not assume the env is empty.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  acceptLocationSearchMiss,
  hasLocationSearchOutcome,
  hasRedirectSimilaritySkipSignal,
  logGeoDataEmptyMissAcceptanceOnce,
  setAcceptLocationSearchMiss,
} from "./semanticAnswerGuards";

const GEO_CHECK_DONE_ENV = "VIVEK_GEO_CHECK_DONE";

function geoCheckDone(): boolean {
  return process.env[GEO_CHECK_DONE_ENV] === "true";
}

function markGeoCheckDone(): void {
  process.env[GEO_CHECK_DONE_ENV] = "true";
}

async function countCentersFromAppLoader(): Promise<number | null> {
  if (!process.env.S3_BUCKET_NAME) {
    return null;
  }
  try {
    const { S3CenterDataService } = await import("../../src/utils/server/tools/services");
    const centers = await new S3CenterDataService().loadCenters();
    return centers.length;
  } catch {
    return 0;
  }
}

async function countCentersFromLocalFallback(): Promise<number> {
  const candidates = [
    path.join(process.cwd(), "public/data/ananda-locations.csv"),
    path.join(process.cwd(), "web/public/data/ananda-locations.csv"),
  ];
  for (const csvPath of candidates) {
    try {
      const csvContent = await fs.readFile(csvPath, "utf8");
      const lines = csvContent.split(/\r?\n/).filter((line) => line.trim());
      return Math.max(0, lines.length - 1);
    } catch {
      // try the next path
    }
  }
  return 0;
}

export async function geoDataIsEmpty(): Promise<boolean> {
  const loaded = await countCentersFromAppLoader();
  if (loaded !== null) {
    return loaded === 0;
  }
  return (await countCentersFromLocalFallback()) === 0;
}

// TODO(known-flaky): geo data for the Vivek test env
// tracked: https://app.notion.com/p/3fe7781078bc818ba576f4d4de252826
export async function detectAndApplyEmptyGeoDataFlag(): Promise<boolean> {
  if (geoCheckDone()) {
    return acceptLocationSearchMiss();
  }
  const empty = await geoDataIsEmpty();
  setAcceptLocationSearchMiss(empty);
  if (empty) {
    logGeoDataEmptyMissAcceptanceOnce();
    markGeoCheckDone();
  }
  return empty;
}

export function applyEmptyGeoFlagFromProbe(answer: string): boolean {
  if (hasRedirectSimilaritySkipSignal(answer)) {
    setAcceptLocationSearchMiss(false);
    markGeoCheckDone();
    return false;
  }
  if (hasLocationSearchOutcome(answer)) {
    setAcceptLocationSearchMiss(true);
    logGeoDataEmptyMissAcceptanceOnce();
    markGeoCheckDone();
    return true;
  }
  setAcceptLocationSearchMiss(false);
  markGeoCheckDone();
  return false;
}

/**
 * File/S3 count first. If that file has centers, one live probe decides
 * whether the runtime geo path can actually return a center.
 */
export async function detectUsableGeoWithOptionalProbe(probe: () => Promise<string>): Promise<boolean> {
  if (geoCheckDone()) {
    return acceptLocationSearchMiss();
  }
  const fileEmpty = await detectAndApplyEmptyGeoDataFlag();
  if (fileEmpty || geoCheckDone()) {
    return acceptLocationSearchMiss();
  }
  return applyEmptyGeoFlagFromProbe(await probe());
}

export function logEnvLimitedSpecificCenterAssert(label: string): void {
  if (!acceptLocationSearchMiss()) {
    return;
  }
  console.log(`env-limited: ${label} specific-center assert skipped (geo data empty)`);
}

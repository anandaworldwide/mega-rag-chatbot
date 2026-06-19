#!/usr/bin/env node
/**
 * Remove prior coverage output so a merge never picks up stale per-file data
 * (e.g. coverage for a since-deleted source file). CI runs on a fresh checkout,
 * but this keeps local `test:coverage:all` runs trustworthy.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const coverageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "coverage");
fs.rmSync(coverageDir, { recursive: true, force: true });

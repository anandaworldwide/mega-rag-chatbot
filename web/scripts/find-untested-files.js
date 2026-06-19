#!/usr/bin/env node

// Find files with no unit test coverage
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(projectRoot, "src");
const coveragePath = path.join(projectRoot, "coverage", "coverage-summary.json");

const extensions = [".ts", ".tsx", ".js", ".jsx"];

const ignorePatterns = [
  /\.d\.ts$/,
  /\.test\./,
  /\.spec\./,
  /\/node_modules\//,
  /\/__tests__\//,
  /\/\.next\//,
];

const loadCoverageData = () => {
  try {
    const coverageData = JSON.parse(fs.readFileSync(coveragePath, "utf8"));
    return Object.keys(coverageData)
      .filter((key) => key !== "total")
      .map((key) => key.replace(projectRoot + path.sep, "").replace(/\\/g, "/"));
  } catch (error) {
    console.error("Error loading coverage data:", error.message);
    console.error("Run `npm run test:coverage:all` first to generate coverage-summary.json");
    return [];
  }
};

const findSourceFiles = (dir, fileList = []) => {
  if (!fs.existsSync(dir)) return fileList;

  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      findSourceFiles(filePath, fileList);
    } else if (
      extensions.includes(path.extname(file)) &&
      !ignorePatterns.some((pattern) => pattern.test(filePath))
    ) {
      fileList.push(path.relative(projectRoot, filePath).replace(/\\/g, "/"));
    }
  });

  return fileList;
};

const findUntestedFiles = () => {
  const coveredFiles = loadCoverageData();
  const allSourceFiles = findSourceFiles(srcRoot);

  const untestedFiles = allSourceFiles.filter((file) => {
    const normalizedPath = file.replace(/\\/g, "/");
    return !coveredFiles.some((coveredFile) => {
      const normalizedCovered = coveredFile.replace(/\\/g, "/");
      return normalizedCovered.endsWith(normalizedPath) || normalizedPath.endsWith(normalizedCovered);
    });
  });

  console.log("\nFiles with no test coverage:");
  console.log("==========================");

  if (untestedFiles.length === 0) {
    console.log("All files have some test coverage.");
  } else {
    const filesByDir = {};

    untestedFiles.forEach((file) => {
      const dir = path.dirname(file);
      if (!filesByDir[dir]) {
        filesByDir[dir] = [];
      }
      filesByDir[dir].push(path.basename(file));
    });

    Object.keys(filesByDir)
      .sort()
      .forEach((dir) => {
        console.log(`\n${dir}/`);
        filesByDir[dir].sort().forEach((file) => {
          console.log(`  - ${file}`);
        });
      });

    console.log(`\nTotal: ${untestedFiles.length} untested files`);
  }

  console.log(`\nCovered files: ${coveredFiles.length}`);
  console.log(`Source files: ${allSourceFiles.length}`);
  if (allSourceFiles.length > 0) {
    console.log(
      `File coverage percentage: ${((coveredFiles.length / allSourceFiles.length) * 100).toFixed(2)}%`
    );
  }
};

findUntestedFiles();

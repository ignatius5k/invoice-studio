"use strict";

const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const vendorManifest = require("./vendor-manifest.js");

const ROOT = join(__dirname, "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(ROOT, relativePath), "utf8"));
}

async function main() {
  const projectPackage = await readJson("package.json");
  const lock = await readJson("package-lock.json");
  const rootLock = lock.packages?.[""];

  for (const dependencyName of Object.keys(projectPackage.dependencies || {})) {
    const declaredVersion = projectPackage.dependencies[dependencyName];
    const lockedDeclaration = rootLock?.dependencies?.[dependencyName];
    const installedPackage = await readJson(`node_modules/${dependencyName}/package.json`);

    if (declaredVersion !== installedPackage.version || lockedDeclaration !== installedPackage.version) {
      throw new Error(
        `${dependencyName} must be exactly pinned. package.json=${declaredVersion}, lock=${lockedDeclaration}, installed=${installedPackage.version}`,
      );
    }
  }

  for (const entry of vendorManifest) {
    const [source, destination] = await Promise.all([
      readFile(join(ROOT, entry.source)),
      readFile(join(ROOT, entry.destination)),
    ]);
    const sourceHash = sha256(source);
    const destinationHash = sha256(destination);
    if (sourceHash !== destinationHash) {
      throw new Error(`${entry.destination} is stale. Run npm run sync:vendor.`);
    }
    process.stdout.write(`${destinationHash}  ${entry.destination}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

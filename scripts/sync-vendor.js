"use strict";

const { copyFile, mkdir } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const vendorManifest = require("./vendor-manifest.js");

const ROOT = join(__dirname, "..");

async function main() {
  for (const entry of vendorManifest) {
    const source = join(ROOT, entry.source);
    const destination = join(ROOT, entry.destination);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    process.stdout.write(`Synced ${entry.destination} from ${entry.packageName}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

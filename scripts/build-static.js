"use strict";

const { cp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const { dirname, join, relative, resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");
const OUTPUT = resolve(ROOT, process.env.BUILD_OUTPUT_DIR || "dist");
const STATIC_FILES = [
  "index.html",
  "styles.css",
  "app.js",
  "backend.js",
  "outbox.js",
  "sw.js",
  "manifest.webmanifest",
  "eng-hoon-residences-logo.png",
  "icon-192.png",
  "icon-512.png",
  "vendor/html2pdf.bundle.min.js",
  "vendor/html2pdf.bundle.min.js.LICENSE.txt",
  "vendor/supabase.js",
  "vendor/supabase.js.LICENSE.txt",
];

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for a deployable build.`);
  return value;
}

function validatedSupabaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("SUPABASE_URL must be a credential-free HTTPS origin.");
  }
  if (url.pathname !== "/") throw new Error("SUPABASE_URL must not include a path.");
  return new URL(url.origin);
}

function validateOutputDirectory() {
  const relativeOutput = relative(ROOT, OUTPUT);
  if (!relativeOutput || relativeOutput.startsWith("..") || relativeOutput.includes("node_modules")) {
    throw new Error("BUILD_OUTPUT_DIR must be a dedicated directory inside the project.");
  }
}

async function copyStaticFile(relativePath) {
  const destination = join(OUTPUT, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(ROOT, relativePath), destination);
}

async function main() {
  validateOutputDirectory();
  const supabaseUrl = validatedSupabaseUrl(requiredEnvironment("SUPABASE_URL"));
  const publishableKey = requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
  if (/YOUR_SUPABASE|service_role|secret/i.test(publishableKey)) {
    throw new Error("Use a Supabase publishable key, never a placeholder, secret, or service-role key.");
  }

  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });
  await Promise.all(STATIC_FILES.map(copyStaticFile));

  const runtimeConfig = `window.INVOICE_STUDIO_SUPABASE = Object.freeze(${JSON.stringify({
    url: supabaseUrl.origin,
    publishableKey,
  }, null, 2)});\n`;
  await writeFile(join(OUTPUT, "supabase-config.js"), runtimeConfig, "utf8");

  const headerTemplate = await readFile(join(ROOT, "deployment", "_headers.template"), "utf8");
  const renderedHeaders = headerTemplate
    .replaceAll("{{SUPABASE_HTTPS_ORIGIN}}", supabaseUrl.origin)
    .replaceAll("{{SUPABASE_WSS_ORIGIN}}", `wss://${supabaseUrl.host}`);
  if (/{{[^}]+}}/.test(renderedHeaders)) throw new Error("An unresolved deployment header placeholder remains.");
  await writeFile(join(OUTPUT, "_headers"), renderedHeaders, "utf8");

  process.stdout.write(`Built ${relative(ROOT, OUTPUT)} for ${supabaseUrl.origin}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

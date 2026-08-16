import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const siteRoot = path.join(repoRoot, "site");
const indexPath = path.join(siteRoot, "index.html");
const packagePath = path.join(repoRoot, "package.json");
const failures = [];

function fail(message) {
  failures.push(message);
}

function isLocalAsset(reference) {
  return (
    reference &&
    !reference.startsWith("#") &&
    !reference.startsWith("/") &&
    !reference.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(reference)
  );
}

const index = fs.readFileSync(indexPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const document = new JSDOM(index).window.document;

if (document.documentElement.lang !== "en") {
  fail('Expected <html lang="en">.');
}
if (document.querySelectorAll("h1").length !== 1) {
  fail("Expected exactly one page h1.");
}
if (!document.querySelector("main#main-content")) {
  fail("Expected #main-content main landmark.");
}
if (!document.querySelector("section.secondary-controls")) {
  fail("Expected the secondary-controls section to parse as a section.");
}

const ids = new Map();
for (const element of document.querySelectorAll("[id]")) {
  const { id } = element;
  if (ids.has(id)) {
    fail(`Duplicate id: #${id}.`);
  }
  ids.set(id, element);
}

for (const link of document.querySelectorAll('a[href^="#"]')) {
  const target = link.getAttribute("href")?.slice(1);
  if (target && !ids.has(target)) {
    fail(`Missing in-page anchor target: #${target}.`);
  }
}

for (const element of document.querySelectorAll("[src], [href]")) {
  const reference = element.getAttribute("src") ?? element.getAttribute("href");
  if (reference?.startsWith("/")) {
    fail(`Root-relative reference is not safe for GitHub Pages: ${reference}.`);
    continue;
  }
  if (!isLocalAsset(reference)) continue;
  const localPath = path.resolve(siteRoot, reference.split(/[?#]/, 1)[0]);
  if (
    (localPath !== siteRoot &&
      !localPath.startsWith(`${siteRoot}${path.sep}`)) ||
    !fs.existsSync(localPath)
  ) {
    fail(`Missing or unsafe local asset: ${reference}.`);
  }
}

for (const image of document.querySelectorAll("img")) {
  if (!image.hasAttribute("alt")) {
    fail(
      `Image is missing alt text: ${image.getAttribute("src") ?? "unknown source"}.`,
    );
  }
}

const canonical = document
  .querySelector('link[rel="canonical"]')
  ?.getAttribute("href");
if (canonical !== "https://liusuzeng.github.io/pi-deck/") {
  fail("Canonical URL is missing or incorrect.");
}

const release = document.querySelector("[data-release-version]");
if (!release) {
  fail("Release-confidence version marker is missing.");
} else if (
  release.getAttribute("data-release-version") !== packageJson.version
) {
  fail(
    `Release-confidence version (${release.getAttribute("data-release-version")}) does not match package.json (${packageJson.version}).`,
  );
}

if (failures.length) {
  console.error("Site validation failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(
  `Site validation passed (${ids.size} IDs, ${document.querySelectorAll("img").length} images, version ${packageJson.version}).`,
);

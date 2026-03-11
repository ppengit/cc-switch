import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "release", "windows");
const preservedInstallerDir = path.join(
  root,
  ".release-cache",
  "preserved-installers",
);
const INSTALLER_RE = /^CC Switch_(.+?)_x64-setup\.exe$/i;

const parseVersion = (raw) => {
  const value = String(raw ?? "").trim();
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    build: Number.parseInt(match[4] ?? "0", 10),
  };
};

const compareVersionsDesc = (a, b) => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  if (pa && pb) {
    if (pa.major !== pb.major) return pb.major - pa.major;
    if (pa.minor !== pb.minor) return pb.minor - pa.minor;
    if (pa.patch !== pb.patch) return pb.patch - pa.patch;
    if (pa.build !== pb.build) return pb.build - pa.build;
    return 0;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return b.localeCompare(a);
};

const getInstallerVersion = (name) =>
  name.match(INSTALLER_RE)?.[1] ?? "";

let entries = [];
try {
  entries = await fs.readdir(releaseDir, { withFileTypes: true });
} catch {
  await fs.rm(preservedInstallerDir, { recursive: true, force: true });
  await fs.mkdir(releaseDir, { recursive: true });
  console.log("No release directory found; skipped installer preservation.");
  process.exit(0);
}

const latestInstaller = entries
  .filter((entry) => entry.isFile() && INSTALLER_RE.test(entry.name))
  .map((entry) => ({
    entry,
    version: getInstallerVersion(entry.name),
  }))
  .sort((left, right) => compareVersionsDesc(left.version, right.version))[0];

await fs.rm(preservedInstallerDir, { recursive: true, force: true });

if (latestInstaller) {
  await fs.mkdir(preservedInstallerDir, { recursive: true });
  const src = path.join(releaseDir, latestInstaller.entry.name);
  const dest = path.join(preservedInstallerDir, latestInstaller.entry.name);
  await fs.copyFile(src, dest);
  console.log(`Preserved installer: ${src} -> ${dest}`);
} else {
  console.log("No previous installer to preserve.");
}

await fs.rm(releaseDir, { recursive: true, force: true });
await fs.mkdir(releaseDir, { recursive: true });
console.log("Prepared Windows release directory.");

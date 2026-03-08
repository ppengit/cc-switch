import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const preservedInstallerDir = path.join(
  root,
  ".release-cache",
  "preserved-installers",
);

let entries = [];
try {
  entries = await fs.readdir(distDir, { withFileTypes: true });
} catch {
  await fs.rm(preservedInstallerDir, { recursive: true, force: true });
  console.log("No dist directory found; skipped installer preservation.");
  process.exit(0);
}

const installers = entries.filter(
  (entry) =>
    entry.isFile() && /^CC Switch_.*_x64-setup\.exe$/i.test(entry.name),
);

await fs.rm(preservedInstallerDir, { recursive: true, force: true });

if (installers.length === 0) {
  console.log("No installers to preserve.");
  process.exit(0);
}

await fs.mkdir(preservedInstallerDir, { recursive: true });

for (const entry of installers) {
  const src = path.join(distDir, entry.name);
  const dest = path.join(preservedInstallerDir, entry.name);
  await fs.copyFile(src, dest);
  console.log(`Preserved installer: ${src} -> ${dest}`);
}

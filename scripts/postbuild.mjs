import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");

const exePath = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  "cc-switch.exe",
);

const tauriConfPath = path.join(root, "src-tauri", "tauri.conf.json");
let version = "";
try {
  const conf = JSON.parse(await fs.readFile(tauriConfPath, "utf8"));
  version = String(conf?.version ?? "").trim();
} catch {
  // ignore missing or invalid config
}

const nsisInstaller =
  version.length > 0
    ? path.join(
        root,
        "src-tauri",
        "target",
        "release",
        "bundle",
        "nsis",
        `CC Switch_${version}_x64-setup.exe`,
      )
    : "";

await fs.mkdir(distDir, { recursive: true });

const outputs = [exePath, nsisInstaller].filter(Boolean);
for (const src of outputs) {
  try {
    await fs.access(src);
  } catch {
    console.warn(`Missing build output: ${src}`);
    continue;
  }
  const dest = path.join(distDir, path.basename(src));
  await fs.copyFile(src, dest);
  console.log(`Copied ${src} -> ${dest}`);
}

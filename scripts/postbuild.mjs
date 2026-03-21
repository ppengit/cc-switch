import fs from "node:fs/promises";
import path from "node:path";

const MAX_KEEP_INSTALLERS = 2;
const root = process.cwd();
const releaseDir = path.join(root, "release", "windows");
const preservedInstallerDir = path.join(
  root,
  ".release-cache",
  "preserved-installers",
);
const INSTALLER_RE = /^CC Switch_(.+?)_x64-setup\.exe$/i;

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

const pruneDistArtifacts = async () => {
  let entries = [];
  try {
    entries = await fs.readdir(releaseDir, { withFileTypes: true });
  } catch {
    return;
  }

  const installers = [];

  for (const entry of entries) {
    const target = path.join(releaseDir, entry.name);
    if (entry.isFile() && INSTALLER_RE.test(entry.name)) {
      installers.push({
        name: entry.name,
        version: getInstallerVersion(entry.name),
      });
      continue;
    }

    await fs.rm(target, { recursive: true, force: true });
    console.log(`Removed non-installer artifact: ${target}`);
  }

  const keepVersions = new Set(
    Array.from(new Set(installers.map((item) => item.version)))
      .sort(compareVersionsDesc)
      .slice(0, MAX_KEEP_INSTALLERS),
  );

  for (const item of installers) {
    if (keepVersions.has(item.version)) continue;
    const target = path.join(releaseDir, item.name);
    await fs.rm(target, { force: true });
    console.log(`Removed old installer: ${target}`);
  }
};

const restorePreservedInstallers = async () => {
  let entries = [];
  try {
    entries = await fs.readdir(preservedInstallerDir, { withFileTypes: true });
  } catch {
    return;
  }

  const installers = entries.filter(
    (entry) => entry.isFile() && INSTALLER_RE.test(entry.name),
  );

  for (const entry of installers) {
    const src = path.join(preservedInstallerDir, entry.name);
    const dest = path.join(releaseDir, entry.name);

    try {
      await fs.access(dest);
      continue;
    } catch {
      // restore only missing installers
    }

    await fs.copyFile(src, dest);
    console.log(`Restored preserved installer: ${src} -> ${dest}`);
  }

  await fs.rm(preservedInstallerDir, { recursive: true, force: true });
};

const resolveNsisInstaller = async () => {
  if (!nsisInstaller) return "";
  try {
    await fs.access(nsisInstaller);
    return nsisInstaller;
  } catch {
    const nsisDir = path.join(
      root,
      "src-tauri",
      "target",
      "release",
      "bundle",
      "nsis",
    );
    try {
      const entries = await fs.readdir(nsisDir);
      const candidates = entries
        .filter((name) => INSTALLER_RE.test(name))
        .map((name) => ({
          name,
          version: getInstallerVersion(name),
        }))
        .sort((left, right) =>
          compareVersionsDesc(left.version, right.version),
        );
      return candidates.length > 0
        ? path.join(nsisDir, candidates[0].name)
        : "";
    } catch {
      return "";
    }
  }
};

await fs.mkdir(releaseDir, { recursive: true });

const installerPath = await resolveNsisInstaller();
if (!installerPath) {
  console.warn("Missing build output: Windows NSIS installer.");
} else {
  const dest = path.join(releaseDir, path.basename(installerPath));
  await fs.copyFile(installerPath, dest);
  console.log(`Copied ${installerPath} -> ${dest}`);
}

await restorePreservedInstallers();
await pruneDistArtifacts();

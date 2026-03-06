import fs from "node:fs/promises";
import path from "node:path";

const MAX_KEEP_VERSIONS = 3;
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

const matchArtifactVersion = (name) => {
  const runtime = name.match(/^cc-switch_(.+?)_x64\.exe$/i);
  if (runtime) {
    return { version: runtime[1], kind: "runtime" };
  }

  const installer = name.match(/^CC Switch_(.+?)_x64-setup\.exe$/i);
  if (installer) {
    return { version: installer[1], kind: "installer" };
  }

  return null;
};

const pruneDistArtifacts = async () => {
  let entries = [];
  try {
    entries = await fs.readdir(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  const versionedArtifacts = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const matched = matchArtifactVersion(entry.name);
      if (!matched) return null;
      return { name: entry.name, ...matched };
    })
    .filter(Boolean);

  if (versionedArtifacts.length === 0) return;

  const versions = Array.from(
    new Set(versionedArtifacts.map((item) => item.version)),
  ).sort(compareVersionsDesc);

  const keepVersions = new Set(versions.slice(0, MAX_KEEP_VERSIONS));
  const removeTargets = versionedArtifacts.filter(
    (item) => !keepVersions.has(item.version),
  );

  for (const item of removeTargets) {
    const target = path.join(distDir, item.name);
    await fs.unlink(target);
    console.log(`Removed old artifact: ${target}`);
  }
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
        .filter((name) => /^CC Switch_.*_x64-setup\.exe$/i.test(name))
        .map((name) => path.join(nsisDir, name));
      return candidates.at(-1) ?? "";
    } catch {
      return "";
    }
  }
};

await fs.mkdir(distDir, { recursive: true });

const copyTargets = [];
if (version) {
  copyTargets.push({ src: exePath, destName: `cc-switch_${version}_x64.exe` });
  copyTargets.push({ src: exePath, destName: "cc-switch.exe" });
} else {
  copyTargets.push({ src: exePath, destName: path.basename(exePath) });
}

const installerPath = await resolveNsisInstaller();
if (installerPath) {
  copyTargets.push({
    src: installerPath,
    destName: path.basename(installerPath),
  });
}

for (const { src, destName } of copyTargets) {
  try {
    await fs.access(src);
  } catch {
    console.warn(`Missing build output: ${src}`);
    continue;
  }
  const dest = path.join(distDir, destName);
  await fs.copyFile(src, dest);
  console.log(`Copied ${src} -> ${dest}`);
}

await pruneDistArtifacts();

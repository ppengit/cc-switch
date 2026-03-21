import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();

const packageJsonPath = path.join(rootDir, "package.json");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");

const parseVersion = (rawVersion) => {
  const version = String(rawVersion ?? "").trim();
  const core = version.split(/[+-]/, 1)[0];
  if (!/^\d+\.\d+\.\d+$/.test(core)) {
    throw new Error(`Unsupported base version format: ${version}`);
  }

  const buildMatch = version.match(/\+(\d+)$/);
  const buildNumber = buildMatch ? Number.parseInt(buildMatch[1], 10) : 0;
  const nextBuild = Number.isFinite(buildNumber) ? buildNumber + 1 : 1;

  return {
    core,
    nextBuild,
    nextVersion: `${core}+${nextBuild}`,
    displayVersion: `${core}.${nextBuild}`,
  };
};

const readJson = async (filePath) =>
  JSON.parse(await fs.readFile(filePath, "utf8"));

const writeJson = async (filePath, data) => {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
};

const main = async () => {
  const packageJson = await readJson(packageJsonPath);
  const tauriConfig = await readJson(tauriConfigPath);
  const cargoToml = await fs.readFile(cargoTomlPath, "utf8");

  const baseVersion =
    tauriConfig.version || packageJson.version || "3.11.1";
  const { nextVersion, displayVersion } = parseVersion(baseVersion);

  packageJson.version = nextVersion;
  tauriConfig.version = nextVersion;

  const updatedCargoToml = cargoToml.replace(
    /^version\s*=\s*".*"$/m,
    `version = "${nextVersion}"`,
  );

  await Promise.all([
    writeJson(packageJsonPath, packageJson),
    writeJson(tauriConfigPath, tauriConfig),
    fs.writeFile(cargoTomlPath, updatedCargoToml, "utf8"),
  ]);

  console.log(
    `[version] bumped to ${nextVersion} (display: ${displayVersion})`,
  );
};

main().catch((error) => {
  console.error("[version] bump failed:", error);
  process.exit(1);
});

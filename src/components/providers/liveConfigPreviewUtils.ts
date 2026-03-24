import type { AppConfigPreviewFile } from "@/lib/api/config";

export type LiveConfigEditorMode = "json" | "text";
export type LiveConfigTextSyntax = "plain" | "toml" | "env";

export function getLiveConfigEditorMode(
  file: Pick<AppConfigPreviewFile, "label" | "path">,
): LiveConfigEditorMode {
  const label = file.label.toLowerCase();
  const path = file.path.toLowerCase();
  return label.endsWith(".json") || path.endsWith(".json") ? "json" : "text";
}

export function getLiveConfigTextSyntax(
  file: Pick<AppConfigPreviewFile, "label" | "path">,
): LiveConfigTextSyntax {
  const label = file.label.toLowerCase();
  const path = file.path.toLowerCase();

  if (label.endsWith(".toml") || path.endsWith(".toml")) {
    return "toml";
  }

  if (
    label === ".env" ||
    path.endsWith("/.env") ||
    path.endsWith("\\.env") ||
    label.endsWith(".env") ||
    path.endsWith(".env")
  ) {
    return "env";
  }

  return "plain";
}

export function getPreviewDraftValue(
  file: AppConfigPreviewFile,
  drafts: Record<string, string>,
): string {
  return drafts[file.path] ?? file.actualText;
}

export function isPreviewDraftDirty(
  file: AppConfigPreviewFile,
  drafts: Record<string, string>,
): boolean {
  return getPreviewDraftValue(file, drafts) !== file.actualText;
}

export function getDirtyPreviewFiles(
  files: AppConfigPreviewFile[],
  drafts: Record<string, string>,
): AppConfigPreviewFile[] {
  return files.filter((file) => isPreviewDraftDirty(file, drafts));
}

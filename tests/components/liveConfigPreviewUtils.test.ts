import { describe, expect, it } from "vitest";
import type { AppConfigPreviewFile } from "@/lib/api/config";
import {
  getLiveConfigEditorMode,
  getLiveConfigTextSyntax,
  getDirtyPreviewFiles,
  getPreviewDraftValue,
  isPreviewDraftDirty,
} from "@/components/providers/liveConfigPreviewUtils";

const createPreviewFile = (
  overrides: Partial<AppConfigPreviewFile> = {},
): AppConfigPreviewFile => ({
  label: overrides.label ?? "config.json",
  path: overrides.path ?? "/tmp/config.json",
  exists: overrides.exists ?? true,
  expectedText: overrides.expectedText ?? '{"model":"expected"}',
  actualText: overrides.actualText ?? '{"model":"actual"}',
  differs: overrides.differs ?? true,
});

describe("liveConfigPreviewUtils", () => {
  it("chooses json editor only for json files", () => {
    expect(
      getLiveConfigEditorMode(
        createPreviewFile({
          label: "settings.json",
          path: "/tmp/settings.json",
        }),
      ),
    ).toBe("json");

    expect(
      getLiveConfigEditorMode(
        createPreviewFile({
          label: "config.toml",
          path: "/tmp/config.toml",
        }),
      ),
    ).toBe("text");

    expect(
      getLiveConfigEditorMode(
        createPreviewFile({
          label: ".env",
          path: "/tmp/.env",
        }),
      ),
    ).toBe("text");
  });

  it("derives text syntax kind for toml and env files", () => {
    expect(
      getLiveConfigTextSyntax(
        createPreviewFile({
          label: "config.toml",
          path: "/tmp/config.toml",
        }),
      ),
    ).toBe("toml");

    expect(
      getLiveConfigTextSyntax(
        createPreviewFile({
          label: ".env",
          path: "/tmp/.env",
        }),
      ),
    ).toBe("env");

    expect(
      getLiveConfigTextSyntax(
        createPreviewFile({
          label: "settings.txt",
          path: "/tmp/settings.txt",
        }),
      ),
    ).toBe("plain");
  });

  it("returns actual text when no draft exists", () => {
    const file = createPreviewFile();

    expect(getPreviewDraftValue(file, {})).toBe(file.actualText);
    expect(isPreviewDraftDirty(file, {})).toBe(false);
  });

  it("marks a file dirty only when draft differs from actual text", () => {
    const file = createPreviewFile();

    expect(
      isPreviewDraftDirty(file, {
        [file.path]: '{"model":"updated"}',
      }),
    ).toBe(true);

    expect(
      isPreviewDraftDirty(file, {
        [file.path]: file.actualText,
      }),
    ).toBe(false);
  });

  it("collects only dirty preview files", () => {
    const alpha = createPreviewFile({
      label: "alpha.json",
      path: "/tmp/alpha.json",
    });
    const beta = createPreviewFile({
      label: "beta.json",
      path: "/tmp/beta.json",
      actualText: '{"model":"beta"}',
    });

    const dirtyFiles = getDirtyPreviewFiles([alpha, beta], {
      [alpha.path]: '{"model":"changed"}',
      [beta.path]: beta.actualText,
    });

    expect(dirtyFiles).toEqual([alpha]);
  });
});

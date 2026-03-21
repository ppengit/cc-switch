const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitTopLevelTomlSection = (tomlText: string) => {
  const tableMatch = tomlText.match(/^\s*\[[^\n]+\]\s*$/m);
  if (!tableMatch || tableMatch.index === undefined) {
    return {
      root: tomlText,
      suffix: "",
    };
  }

  return {
    root: tomlText.slice(0, tableMatch.index),
    suffix: tomlText.slice(tableMatch.index),
  };
};

const mergeTomlSections = (root: string, suffix: string) => {
  const trimmedRoot = root.trimEnd();
  const trimmedSuffix = suffix.trimStart();

  if (!trimmedRoot && !trimmedSuffix) {
    return "";
  }

  if (!trimmedRoot) {
    return `${trimmedSuffix.trimEnd()}\n`;
  }

  if (!trimmedSuffix) {
    return `${trimmedRoot}\n`;
  }

  return `${trimmedRoot}\n\n${trimmedSuffix.trimEnd()}\n`;
};

export const getTomlStringValue = (
  tomlText: string,
  key: string,
): string | null => {
  if (!tomlText.trim()) return null;
  const { root } = splitTopLevelTomlSection(tomlText);
  const pattern = `^\\s*${escapeRegExp(key)}\\s*=\\s*["']?([^"'\\n]+)["']?\\s*$`;
  const match = new RegExp(pattern, "m").exec(root);
  return match?.[1]?.trim() ?? null;
};

export const upsertTomlStringValue = (
  tomlText: string,
  key: string,
  value: string,
): string => {
  const { root, suffix } = splitTopLevelTomlSection(tomlText);
  const nextLine = `${key} = "${value}"`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$\\n?`, "gm");
  const cleaned = root.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
  const trimmed = cleaned.trimEnd();
  if (!trimmed) {
    return mergeTomlSections(`${nextLine}\n`, suffix);
  }
  return mergeTomlSections(`${trimmed}\n${nextLine}\n`, suffix);
};

export const removeTomlKey = (tomlText: string, key: string): string => {
  const { root, suffix } = splitTopLevelTomlSection(tomlText);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$\\n?`, "m");
  if (!pattern.test(root)) return tomlText;
  const updated = root.replace(pattern, "");
  const cleaned = updated.replace(/\n{3,}/g, "\n\n").trim();
  return mergeTomlSections(cleaned ? `${cleaned}\n` : "", suffix);
};

export const removeTomlKeyIfMatch = (
  tomlText: string,
  key: string,
  expectedValue: string,
): string => {
  const current = getTomlStringValue(tomlText, key);
  if (current !== expectedValue) return tomlText;
  return removeTomlKey(tomlText, key);
};

export const getTomlBoolValue = (
  tomlText: string,
  key: string,
): boolean | null => {
  if (!tomlText.trim()) return null;
  const { root } = splitTopLevelTomlSection(tomlText);
  const pattern = `^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$`;
  const match = new RegExp(pattern, "mi").exec(root);
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === "true";
};

export const upsertTomlBoolValue = (
  tomlText: string,
  key: string,
  value: boolean,
): string => {
  const { root, suffix } = splitTopLevelTomlSection(tomlText);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");
  const nextLine = `${key} = ${value ? "true" : "false"}`;
  if (pattern.test(root)) {
    return mergeTomlSections(root.replace(pattern, nextLine), suffix);
  }
  const trimmed = root.trimEnd();
  if (!trimmed) {
    return mergeTomlSections(`${nextLine}\n`, suffix);
  }
  return mergeTomlSections(`${trimmed}\n${nextLine}\n`, suffix);
};

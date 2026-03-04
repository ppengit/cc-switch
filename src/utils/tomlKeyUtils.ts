const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getTomlStringValue = (
  tomlText: string,
  key: string,
): string | null => {
  if (!tomlText.trim()) return null;
  const pattern = `^\\s*${escapeRegExp(key)}\\s*=\\s*["']?([^"'\\n]+)["']?\\s*$`;
  const match = new RegExp(pattern, "m").exec(tomlText);
  return match?.[1]?.trim() ?? null;
};

export const upsertTomlStringValue = (
  tomlText: string,
  key: string,
  value: string,
): string => {
  const nextLine = `${key} = "${value}"`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$\\n?`, "gm");
  const cleaned = tomlText.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
  const trimmed = cleaned.trimEnd();
  if (!trimmed) {
    return `${nextLine}\n`;
  }
  const tableMatch = trimmed.match(/^\s*\[.+?\]/m);
  if (tableMatch && tableMatch.index !== undefined) {
    const insertAt = tableMatch.index;
    const prefix = trimmed.slice(0, insertAt).trimEnd();
    const suffix = trimmed.slice(insertAt);
    const leading = prefix ? `${prefix}\n\n` : "";
    return `${leading}${nextLine}\n${suffix}\n`;
  }
  return `${trimmed}\n${nextLine}\n`;
};

export const removeTomlKey = (tomlText: string, key: string): string => {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$\\n?`, "m");
  if (!pattern.test(tomlText)) return tomlText;
  const updated = tomlText.replace(pattern, "");
  const cleaned = updated.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned ? `${cleaned}\n` : "";
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
  const pattern = `^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$`;
  const match = new RegExp(pattern, "mi").exec(tomlText);
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === "true";
};

export const upsertTomlBoolValue = (
  tomlText: string,
  key: string,
  value: boolean,
): string => {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");
  const nextLine = `${key} = ${value ? "true" : "false"}`;
  if (pattern.test(tomlText)) {
    return tomlText.replace(pattern, nextLine);
  }
  const trimmed = tomlText.trimEnd();
  if (!trimmed) {
    return `${nextLine}\n`;
  }
  return `${trimmed}\n${nextLine}\n`;
};

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function fmtInt(
  value: unknown,
  locale?: string,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return new Intl.NumberFormat(locale).format(Math.trunc(num));
}

export function fmtUsd(
  value: unknown,
  digits: number,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return `$${num.toFixed(digits)}`;
}

export function getLocaleFromLanguage(language: string): string {
  if (!language) return "en-US";
  if (language.startsWith("zh")) return "zh-CN";
  if (language.startsWith("ja")) return "ja-JP";
  return "en-US";
}

function trimTrailingZeros(value: string): string {
  return value.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

export function fmtTokenCompact(
  value: unknown,
  fallback: string = "--",
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;

  const absValue = Math.abs(num);
  const units = [
    { base: 1_000_000_000_000, suffix: "T" },
    { base: 1_000_000_000, suffix: "B" },
    { base: 1_000_000, suffix: "M" },
    { base: 1_000, suffix: "K" },
  ];

  for (const unit of units) {
    if (absValue >= unit.base) {
      const scaled = num / unit.base;
      const digits =
        Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
      return `${trimTrailingZeros(scaled.toFixed(digits))}${unit.suffix}`;
    }
  }

  return fmtInt(num);
}

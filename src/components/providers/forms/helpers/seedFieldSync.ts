export type SeedSyncField = "name" | "websiteUrl" | "apiUrl";

export type SeedFieldValues = Record<SeedSyncField, string>;

export interface SeedFieldSyncPlan {
  updates: Partial<Record<SeedSyncField, string>>;
}

const ALL_SEED_FIELDS: SeedSyncField[] = ["name", "websiteUrl", "apiUrl"];

export function buildSeedFieldSyncPlan({
  source,
  value,
  currentValues,
  enabledFields,
}: {
  source: SeedSyncField;
  value: string;
  currentValues: SeedFieldValues;
  enabledFields: SeedSyncField[];
}): SeedFieldSyncPlan {
  const enabledSet = new Set(enabledFields);
  const updates: Partial<Record<SeedSyncField, string>> = {};

  for (const field of ALL_SEED_FIELDS) {
    if (field === source || !enabledSet.has(field)) {
      continue;
    }

    if (currentValues[field].trim() === "") {
      updates[field] = value;
    }
  }

  return {
    updates,
  };
}

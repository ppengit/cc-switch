export type SeedSyncField = "name" | "websiteUrl" | "apiUrl";

export type SeedFieldValues = Record<SeedSyncField, string>;

export type SeedFieldFollowers = Record<SeedSyncField, SeedSyncField | null>;

export interface SeedFieldSyncPlan {
  nextFollowers: SeedFieldFollowers;
  updates: Partial<Record<SeedSyncField, string>>;
}

const ALL_SEED_FIELDS: SeedSyncField[] = ["name", "websiteUrl", "apiUrl"];

export function createEmptySeedFieldFollowers(): SeedFieldFollowers {
  return {
    name: null,
    websiteUrl: null,
    apiUrl: null,
  };
}

export function buildSeedFieldSyncPlan({
  source,
  value,
  currentValues,
  currentFollowers,
  enabledFields,
}: {
  source: SeedSyncField;
  value: string;
  currentValues: SeedFieldValues;
  currentFollowers: SeedFieldFollowers;
  enabledFields: SeedSyncField[];
}): SeedFieldSyncPlan {
  const enabledSet = new Set(enabledFields);
  const nextFollowers = { ...currentFollowers };
  const updates: Partial<Record<SeedSyncField, string>> = {};

  for (const field of ALL_SEED_FIELDS) {
    if (!enabledSet.has(field)) {
      nextFollowers[field] = null;
    }
  }

  nextFollowers[source] = null;

  for (const field of ALL_SEED_FIELDS) {
    if (field === source || !enabledSet.has(field)) {
      continue;
    }

    if (
      currentValues[field].trim() === "" ||
      currentFollowers[field] === source
    ) {
      updates[field] = value;
      nextFollowers[field] = source;
    }
  }

  return {
    nextFollowers,
    updates,
  };
}

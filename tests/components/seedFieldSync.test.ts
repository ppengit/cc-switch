import { describe, expect, it } from "vitest";
import {
  buildSeedFieldSyncPlan,
  createEmptySeedFieldFollowers,
} from "@/components/providers/forms/helpers/seedFieldSync";

describe("seedFieldSync", () => {
  it("会让最初为空的字段持续跟随首个输入字段", () => {
    let followers = createEmptySeedFieldFollowers();

    const firstPlan = buildSeedFieldSyncPlan({
      source: "name",
      value: "h",
      currentValues: {
        name: "",
        websiteUrl: "",
        apiUrl: "",
      },
      currentFollowers: followers,
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(firstPlan.updates).toEqual({
      websiteUrl: "h",
      apiUrl: "h",
    });

    followers = firstPlan.nextFollowers;

    const secondPlan = buildSeedFieldSyncPlan({
      source: "name",
      value: "https://demo",
      currentValues: {
        name: "h",
        websiteUrl: "h",
        apiUrl: "h",
      },
      currentFollowers: followers,
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(secondPlan.updates).toEqual({
      websiteUrl: "https://demo",
      apiUrl: "https://demo",
    });
  });

  it("目标字段被手动修改后会停止跟随", () => {
    const initialFollowers = {
      name: null,
      websiteUrl: "name" as const,
      apiUrl: "name" as const,
    };

    const websitePlan = buildSeedFieldSyncPlan({
      source: "websiteUrl",
      value: "https://site.example",
      currentValues: {
        name: "https://demo",
        websiteUrl: "https://demo",
        apiUrl: "https://demo",
      },
      currentFollowers: initialFollowers,
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(websitePlan.updates).toEqual({});

    const nextPlan = buildSeedFieldSyncPlan({
      source: "name",
      value: "https://next.example",
      currentValues: {
        name: "https://demo",
        websiteUrl: "https://site.example",
        apiUrl: "https://demo",
      },
      currentFollowers: websitePlan.nextFollowers,
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(nextPlan.updates).toEqual({
      apiUrl: "https://next.example",
    });
  });

  it("已有内容的字段不会被新的同步覆盖", () => {
    const plan = buildSeedFieldSyncPlan({
      source: "name",
      value: "OpenAI",
      currentValues: {
        name: "",
        websiteUrl: "https://manual.example",
        apiUrl: "",
      },
      currentFollowers: createEmptySeedFieldFollowers(),
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(plan.updates).toEqual({
      apiUrl: "OpenAI",
    });
  });

  it("API 地址字段不可用时不会继续参与同步", () => {
    const plan = buildSeedFieldSyncPlan({
      source: "name",
      value: "Provider",
      currentValues: {
        name: "",
        websiteUrl: "",
        apiUrl: "Provider",
      },
      currentFollowers: {
        name: null,
        websiteUrl: null,
        apiUrl: "name",
      },
      enabledFields: ["name", "websiteUrl"],
    });

    expect(plan.updates).toEqual({
      websiteUrl: "Provider",
    });
    expect(plan.nextFollowers.apiUrl).toBeNull();
  });
});

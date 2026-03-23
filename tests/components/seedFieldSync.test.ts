import { describe, expect, it } from "vitest";
import { buildSeedFieldSyncPlan } from "@/components/providers/forms/helpers/seedFieldSync";

describe("seedFieldSync", () => {
  it("只会在目标字段为空时补充同步，不会持续跟随覆盖", () => {
    const firstPlan = buildSeedFieldSyncPlan({
      source: "name",
      value: "h",
      currentValues: {
        name: "",
        websiteUrl: "",
        apiUrl: "",
      },
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(firstPlan.updates).toEqual({
      websiteUrl: "h",
      apiUrl: "h",
    });

    const secondPlan = buildSeedFieldSyncPlan({
      source: "name",
      value: "https://demo",
      currentValues: {
        name: "h",
        websiteUrl: "h",
        apiUrl: "h",
      },
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(secondPlan.updates).toEqual({});
  });

  it("目标字段清空后会在下次输入时再次补空同步", () => {
    const plan = buildSeedFieldSyncPlan({
      source: "name",
      value: "https://next.example",
      currentValues: {
        name: "https://demo",
        websiteUrl: "",
        apiUrl: "https://demo",
      },
      enabledFields: ["name", "websiteUrl", "apiUrl"],
    });

    expect(plan.updates).toEqual({
      websiteUrl: "https://next.example",
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
      enabledFields: ["name", "websiteUrl"],
    });

    expect(plan.updates).toEqual({
      websiteUrl: "Provider",
    });
  });
});

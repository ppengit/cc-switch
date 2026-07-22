import { beforeEach, describe, expect, it } from "vitest";
import { usageApi } from "@/lib/api/usage";
import {
  getRequestLogsState,
  getUsageSummaryByAppState,
  resetProviderState,
} from "../msw/state";

describe("usageApi request-log clearing with MSW state", () => {
  beforeEach(() => {
    resetProviderState();
  });

  it("clears persisted request logs without changing usage summaries", async () => {
    const summaryStateBefore = getUsageSummaryByAppState();
    const summaryResponseBefore = await usageApi.getUsageSummaryByApp();
    const logsBefore = await usageApi.getRequestLogs({}, 0, 20);

    expect(logsBefore.total).toBe(2);
    expect(logsBefore.data).toEqual(getRequestLogsState());
    expect(summaryResponseBefore).toEqual(summaryStateBefore);

    await expect(usageApi.clearRequestLogs()).resolves.toBe(2);

    const logsAfter = await usageApi.getRequestLogs({}, 0, 20);
    const summaryResponseAfter = await usageApi.getUsageSummaryByApp();

    expect(logsAfter).toEqual({
      data: [],
      total: 0,
      page: 0,
      pageSize: 20,
    });
    expect(getRequestLogsState()).toEqual([]);
    expect(summaryResponseAfter).toEqual(summaryResponseBefore);
    expect(getUsageSummaryByAppState()).toEqual(summaryStateBefore);
  });
});

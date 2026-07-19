import { describe, expect, it } from "vitest";
import {
  normalizeResponseReplayConfigForSave,
  parseResponseReplayKeywordGroups,
  parseResponseReplayStatuses,
  responseReplayEditorConfig,
} from "@/lib/responseReplay";

describe("response replay configuration variables", () => {
  it("parses status codes and preserves AND/OR keyword semantics", () => {
    expect(parseResponseReplayStatuses("400, 409; 409 invalid 599")).toEqual([
      400, 409, 599,
    ]);
    expect(
      parseResponseReplayKeywordGroups(
        " Provider_Busy && Please Retry\ninvalid character\n\nprovider_busy && please retry",
      ),
    ).toEqual([["provider_busy", "please retry"], ["invalid character"]]);
  });

  it("seeds defaults while retaining explicit empty arrays", () => {
    expect(responseReplayEditorConfig({}).codexMatchStatuses).toEqual([400]);
    expect(
      responseReplayEditorConfig({ codexMatchStatuses: [] }).codexMatchStatuses,
    ).toEqual([]);
  });

  it("normalizes custom variables and keeps the legacy toggle compatible", () => {
    expect(
      normalizeResponseReplayConfigForSave({
        enabled: true,
        retryCodexBadResponse400: false,
        codexMatchStatuses: [399, 400, 400, 599, 600],
        codexMatchEndpoints: [" /v1/responses ", " /v1/responses "],
        codexMatchKeywordGroups: [["Busy", " busy ", "Try again"]],
        maxRetries: 99,
        initialDelayMs: 20_000,
        maxDelayMs: 100,
      }),
    ).toEqual({
      enabled: true,
      retryHttp429: true,
      retryCodexConfiguredErrors: false,
      codexMatchStatuses: [400, 599],
      codexMatchEndpoints: ["/v1/responses"],
      codexMatchKeywordGroups: [["busy", "try again"]],
      maxRetries: 10,
      initialDelayMs: 100,
      maxDelayMs: 100,
      jitterMs: 100,
      honorRetryAfter: true,
    });
  });
});

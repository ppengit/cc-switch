import { describe, expect, it } from "vitest";
import {
  HTML_PREVIEW_CSP,
  MAX_HTML_PREVIEW_NODES,
  MAX_HTML_PREVIEW_SOURCE_CHARS,
  createHtmlPreviewDocument,
  isLikelyHtml,
} from "@/lib/htmlPreview";

describe("htmlPreview", () => {
  it("detects complete and partial HTML documents without flagging plain text", () => {
    expect(isLikelyHtml("gateway timeout")).toBe(false);
    expect(isLikelyHtml("HTTP 502\n<!doctype html><html></html>")).toBe(true);
    expect(isLikelyHtml("<body><h1>Unavailable</h1></body>")).toBe(true);
    expect(
      isLikelyHtml(`${"gateway preamble ".repeat(500)}<html></html>`),
    ).toBe(true);
  });

  it("keeps inline presentation while removing active and network-capable content", async () => {
    const preview = await createHtmlPreviewDocument(`HTTP 502
      <!doctype html>
      <html>
        <head>
          <meta http-equiv="refresh" content="0;url=https://bad.example">
          <link rel="stylesheet" href="https://bad.example/error.css">
          <style>h1 { color: red; }</style>
          <script>window.top.location = "https://bad.example";</script>
        </head>
        <body onload="steal()">
          <h1>Bad gateway</h1>
          <img src="https://bad.example/pixel.png">
          <a href="https://bad.example">details</a>
          <iframe src="https://bad.example/frame"></iframe>
          <template><script>bad()</script><img src="https://bad.example/template"></template>
          <svg><animate attributeName="href" to="https://bad.example/animate"></animate></svg>
          <input autofocus>
        </body>
      </html>`);

    expect(preview).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`,
    );
    expect(preview).toContain("<style>h1 { color: red; }</style>");
    expect(preview).toContain("<h1>Bad gateway</h1>");
    expect(preview).not.toContain("https://bad.example");
    expect(preview).not.toMatch(/<script\b/i);
    expect(preview).not.toMatch(/<iframe\b/i);
    expect(preview).not.toMatch(/<template\b/i);
    expect(preview).not.toMatch(/<animate\b/i);
    expect(preview).not.toContain("onload=");
    expect(preview).not.toContain("autofocus=");
  });

  it("neutralizes slash-separated URL attributes before any browser DOM exists", async () => {
    const preview = await createHtmlPreviewDocument(`
      <html><body>
        <img/src=https://bad.example/pixel>
        <iframe/src=https://bad.example/frame></iframe>
        <table/background=https://bad.example/table.png><tr><td>status</td></tr></table>
      </body></html>`);

    expect(preview).toContain("<td>status</td>");
    expect(preview).not.toContain("bad.example");
    expect(preview).not.toMatch(/<iframe\b/i);
    expect(preview).not.toMatch(/\s(?:src|background)=/i);
  });

  it("decodes the Rust Option<String> wrapper used by persisted upstream errors", async () => {
    const persistedError =
      '上游错误 (状态码 504): Some("<!doctype html>\\n<html class=\\"gateway-page\\"><body><h1>Bad gateway</h1></body></html>")';
    const preview = await createHtmlPreviewDocument(persistedError);

    expect(preview).toContain('<html class="gateway-page">');
    expect(preview).toContain("<h1>Bad gateway</h1>");
    expect(preview).not.toContain("\\n<html");
    expect(preview).not.toContain('</html>")');
  });

  it("bounds the source parsed by the preview", async () => {
    const marker = "must-not-be-parsed";
    const preview = await createHtmlPreviewDocument(
      `<html><body>${"x".repeat(MAX_HTML_PREVIEW_SOURCE_CHARS)}${marker}</body></html>`,
    );

    expect(preview).not.toContain(marker);
  });

  it("drops queued subtrees that have not been sanitized when the node budget is exhausted", async () => {
    const budgetBurner = "<i></i>".repeat(MAX_HTML_PREVIEW_NODES);
    const preview = await createHtmlPreviewDocument(`
      <html><body>
        <section id="queued"><iframe src="https://bad.example/late"></iframe></section>
        <main>${budgetBurner}</main>
      </body></html>`);

    expect(preview).toContain('<section id="queued"></section>');
    expect(preview).not.toContain("bad.example");
    expect(preview).not.toMatch(/<iframe\b/i);
  });

  it("rejects network-capable and animated CSS even when keywords are escaped", async () => {
    const preview = await createHtmlPreviewDocument(`
      <html><head>
        <style>.safe { color: red; } .leak { background: u\\72l(https://bad.example/css); }</style>
      </head><body>
        <p class="safe" style="color: green">Safe</p>
        <p style="background: u\\72l(https://bad.example/inline)">Blocked</p>
        <p style="animation: pulse 1s infinite">Static</p>
      </body></html>`);

    expect(preview).toContain('style="color: green"');
    expect(preview).not.toContain("bad.example");
    expect(preview).toContain("<p>Static</p>");
    expect(preview).not.toContain("pulse 1s infinite");
    expect(preview).not.toContain("<style>.safe { color: red; }");
  });
});

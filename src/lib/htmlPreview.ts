import type { DefaultTreeAdapterTypes } from "parse5";

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "child-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "manifest-src 'none'",
  "media-src data:",
  "navigate-to 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "worker-src 'none'",
  "style-src 'unsafe-inline'",
  "sandbox",
].join("; ");

const HTML_DETECTION_PREFIX_CHARS = 64 * 1024;
export const MAX_HTML_PREVIEW_SOURCE_CHARS = 512 * 1024;
export const MAX_HTML_PREVIEW_NODES = 20_000;
const MAX_HTML_PREVIEW_CSS_CHARS = 64 * 1024;
const MAX_INLINE_STYLE_ATTRIBUTE_CHARS = 8 * 1024;

const HTML_DOCUMENT_START_PATTERN =
  /<!doctype\s+html\b|<html\b|<head\b|<body\b/i;

const NETWORK_ATTRIBUTE_NAMES = new Set([
  "src",
  "srcset",
  "href",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
  "srcdoc",
  "background",
  "ping",
  "manifest",
]);
const ACTIVE_ELEMENT_NAMES = new Set(
  [
    "script",
    "iframe",
    "object",
    "embed",
    "applet",
    "portal",
    "frame",
    "frameset",
    "base",
    "link",
    "meta",
    "template",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
  ].map((name) => name.toLowerCase()),
);
const DANGEROUS_STYLE_PATTERN =
  /(?:expression\s*\(|-moz-binding\s*:|behavior\s*:|progid\s*:)/i;

const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const UNSAFE_CSS_PATTERN =
  /(?:\burl\s*\(|\b(?:image-set|cross-fade)\s*\(|@(?:import|font-face|keyframes|property)\b|\b(?:animation|transition|behavior)\s*[-\w]*\s*:|expression\s*\(|-moz-binding\s*:|progid\s*:|(?:^|[^\w-])(?:https?|file|data|javascript|vbscript)\s*:)/i;

type HtmlDocument = DefaultTreeAdapterTypes.Document;
type HtmlParentNode = DefaultTreeAdapterTypes.ParentNode;
type HtmlChildNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function isHtmlElement(node: HtmlChildNode): node is HtmlElement {
  return "tagName" in node && "attrs" in node && "childNodes" in node;
}

interface SanitizerState {
  cssChars: number;
  visitedNodes: number;
}

interface PendingHtmlChildren {
  children: HtmlChildNode[];
  parent: HtmlParentNode;
}

function decodeCssEscapes(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      decoded += value[index];
      continue;
    }

    const next = value[index + 1];
    if (next === "\n" || next === "\r" || next === "\f") {
      if (next === "\r" && value[index + 2] === "\n") index += 1;
      index += 1;
      continue;
    }

    const hex = value.slice(index + 1).match(/^[0-9a-f]{1,6}/i)?.[0];
    if (hex) {
      let end = index + 1 + hex.length;
      if (/\s/.test(value[end] ?? "")) end += 1;
      const codePoint = Number.parseInt(hex, 16);
      decoded +=
        codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "\ufffd";
      index = end - 1;
      continue;
    }

    decoded += next;
    index += 1;
  }

  return decoded;
}

function normalizeCssForSafety(value: string): string {
  return decodeCssEscapes(value.replace(CSS_COMMENT_PATTERN, ""))
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function acceptCss(
  value: string,
  state: SanitizerState,
  maxChars: number,
): boolean {
  if (
    value.length > maxChars ||
    state.cssChars + value.length > MAX_HTML_PREVIEW_CSS_CHARS
  ) {
    return false;
  }

  if (
    DANGEROUS_STYLE_PATTERN.test(value) ||
    UNSAFE_CSS_PATTERN.test(normalizeCssForSafety(value))
  ) {
    return false;
  }

  state.cssChars += value.length;
  return true;
}

function getTextValue(node: HtmlChildNode): string {
  return "value" in node && typeof node.value === "string" ? node.value : "";
}

function sanitizeHtmlTree(document: HtmlDocument): void {
  const state: SanitizerState = { cssChars: 0, visitedNodes: 0 };
  // Clear every child list before it can be queued. This makes the node budget
  // a hard output boundary: queued-but-unvisited subtrees remain empty.
  const pendingParents: PendingHtmlChildren[] = [
    { children: [...document.childNodes], parent: document },
  ];
  document.childNodes = [];

  while (
    pendingParents.length > 0 &&
    state.visitedNodes < MAX_HTML_PREVIEW_NODES
  ) {
    const pending = pendingParents.pop();
    if (!pending) continue;

    const sanitizedChildren: HtmlChildNode[] = [];
    for (const child of pending.children) {
      if (state.visitedNodes >= MAX_HTML_PREVIEW_NODES) break;
      state.visitedNodes += 1;

      if (!isHtmlElement(child)) {
        sanitizedChildren.push(child);
        continue;
      }

      const originalChildren = [...child.childNodes];
      child.childNodes = [];

      const tagName = child.tagName.toLowerCase();
      if (ACTIVE_ELEMENT_NAMES.has(tagName)) continue;

      if (tagName === "style") {
        const css = originalChildren.map(getTextValue).join("");
        if (!acceptCss(css, state, MAX_HTML_PREVIEW_CSS_CHARS)) continue;
      }

      child.attrs = child.attrs.filter((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "autofocus") return false;
        if (NETWORK_ATTRIBUTE_NAMES.has(name)) return false;
        if (
          name === "style" &&
          !acceptCss(attribute.value, state, MAX_INLINE_STYLE_ATTRIBUTE_CHARS)
        ) {
          return false;
        }
        return true;
      });

      sanitizedChildren.push(child);
      if (originalChildren.length > 0) {
        pendingParents.push({ children: originalChildren, parent: child });
      }
    }

    pending.parent.childNodes = sanitizedChildren;
  }
}

function decodeRustDebugEscapes(value: string): string {
  let decoded = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index + 1 >= value.length) {
      decoded += character;
      continue;
    }

    const escape = value[index + 1];
    if (escape === "u" && value[index + 2] === "{") {
      const close = value.indexOf("}", index + 3);
      if (close !== -1) {
        const codePoint = Number.parseInt(value.slice(index + 3, close), 16);
        if (
          Number.isSafeInteger(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
        ) {
          decoded += String.fromCodePoint(codePoint);
          index = close;
          continue;
        }
      }
    }

    if (escape === "x") {
      const hex = value.slice(index + 2, index + 4);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 3;
        continue;
      }
    }

    switch (escape) {
      case "0":
        decoded += "\0";
        index += 1;
        break;
      case "n":
        decoded += "\n";
        index += 1;
        break;
      case "r":
        decoded += "\r";
        index += 1;
        break;
      case "t":
        decoded += "\t";
        index += 1;
        break;
      case "\\":
        decoded += "\\";
        index += 1;
        break;
      case '"':
        decoded += '"';
        index += 1;
        break;
      default:
        // Preserve unknown escapes. They may be meaningful in CSS or text.
        decoded += `\\${escape}`;
        index += 1;
        break;
    }
  }

  return decoded;
}

function extractHtmlSource(value: string): string {
  const boundedValue = value.slice(0, MAX_HTML_PREVIEW_SOURCE_CHARS);
  const htmlStart = boundedValue.search(HTML_DOCUMENT_START_PATTERN);

  if (htmlStart < 0) {
    return boundedValue;
  }

  const prefix = boundedValue.slice(0, htmlStart);
  const rustDebugOpening = prefix.lastIndexOf('Some("');
  let source = boundedValue.slice(htmlStart);

  // UpstreamError uses `Option<String>`'s Debug formatting, e.g.
  // `Some("<!doctype html>\\n<html class=\\"...\\">...")`.
  if (rustDebugOpening >= 0) {
    source = decodeRustDebugEscapes(source).replace(/"\s*\)\s*$/, "");
  }

  return source;
}

export function isLikelyHtml(value?: string | null): boolean {
  if (!value) return false;

  const sample = value.slice(0, HTML_DETECTION_PREFIX_CHARS);
  return HTML_DOCUMENT_START_PATTERN.test(sample);
}

/**
 * Builds a static HTML document for an opaque-origin sandboxed iframe.
 * CSP blocks every network-capable source while inline CSS remains available
 * so gateway error pages keep their useful layout.
 */
export async function createHtmlPreviewDocument(
  value: string,
): Promise<string> {
  const boundedValue = extractHtmlSource(value);
  const htmlStart = boundedValue.search(HTML_DOCUMENT_START_PATTERN);
  const source = htmlStart > 0 ? boundedValue.slice(htmlStart) : boundedValue;

  // parse5 is a pure tokenizer/tree builder. It never creates browser DOM
  // elements, so hostile URL attributes cannot trigger a request in the host
  // WebView before sanitization.
  const { parse: parseHtml, serialize: serializeHtml } = await import("parse5");
  const previewDocument = parseHtml(source);
  sanitizeHtmlTree(previewDocument);

  let serialized = serializeHtml(previewDocument);
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  const staticStyle =
    "<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>";
  serialized = serialized.replace(/<head>/i, `<head>${cspMeta}`);
  serialized = serialized.replace(/<\/head>/i, `${staticStyle}</head>`);

  return serialized;
}

export { HTML_PREVIEW_CSP };

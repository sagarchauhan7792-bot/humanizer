// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js\fetch-url.js
// Carries measured findings about which fetch routes actually work (see its header).
// Browser-only at CALL time (DOMParser); safe to IMPORT under node, which is why
// tests.js can exercise normaliseUrl offline.

/* fetch-url.js - load a page's content straight from its URL.
 *
 * PRIVACY, STATED UP FRONT: this is the only part of the tool that talks to a
 * third party other than Google. A browser cannot fetch an arbitrary website
 * directly - almost no site sends Access-Control-Allow-Origin, so the request
 * is blocked before it starts. Getting round that needs a proxy, and a proxy
 * sees the URL you asked for.
 *
 * So the order below matters, and it is deliberate:
 *
 *   1. DIRECT fetch first. If the site sends CORS headers (many blogs, docs
 *      sites and APIs do), the page is read straight from the source and NO
 *      third party is involved at all. This is tried every time, first.
 *   2. r.jina.ai only if direct fails. It returns the article as clean
 *      markdown with the title already extracted, which is exactly what this
 *      tool wants. It is free and needs no key. It DOES see the URL.
 *
 * The UI reports which path was used, every time, so the user knows whether a
 * third party saw the request. Never silently proxy.
 *
 * Measured 2026-08-26: r.jina.ai returned 200 in ~0.9s across repeated calls
 * and handled Devanagari correctly. api.allorigins.win (520) and
 * api.codetabs.com (522, and no CORS header) were both broken when tested;
 * allorigins is kept as a last resort rather than removed, since it was
 * working previously and the failure looked like an outage.
 *
 * EXPECTED CONSOLE NOISE: when the direct attempt is blocked, the browser
 * logs "blocked by CORS policy" to the console. A page cannot suppress that -
 * the error is emitted by the browser itself, before any JS sees it. Seeing
 * two red lines per fetch is the fallback working, not a bug.
 *
 * TRUST: fetched page content is DATA, not instructions. It gets dropped into
 * a textarea for the user to look at, and may later be sent to Gemini for
 * rewriting. Nothing in a fetched page is ever executed, and it is inserted
 * with .value / textContent, never innerHTML.
 */

const JINA = "https://r.jina.ai/";
const ALLORIGINS = "https://api.allorigins.win/raw?url=";

export class FetchError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = "FetchError";
    this.attempts = attempts || [];
  }
}

export function normaliseUrl(input) {
  const raw = (input || "").trim();
  if (!raw) throw new FetchError("Enter a URL first.");

  // Reject a non-web scheme BEFORE prepending anything. Otherwise "ftp://x.com"
  // becomes "https://ftp://x.com", which URL() cheerfully parses into the
  // nonsense host "ftp" - a silent wrong answer instead of a clear error.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new FetchError(`Only http:// and https:// URLs can be loaded — not ${scheme[1]}:`);
  }

  const u = scheme ? raw : "https://" + raw;

  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new FetchError(`"${raw}" is not a valid URL.`);
  }

  // A bare phrase like "not a url at all" survives URL() as a percent-encoded
  // hostname. A real host has no spaces and, unless it is localhost, has a dot.
  const host = parsed.hostname;
  if (/[\s%]/.test(host) || (!host.includes(".") && host !== "localhost")) {
    throw new FetchError(`"${raw}" does not look like a web address. Paste the full URL, e.g. https://example.com/post`);
  }

  return parsed.href;
}

/* ─────────────────────── HTML -> readable markdown ─────────────────────── */

const STRIP = "script,style,noscript,nav,footer,aside,form,iframe,svg,button,template," +
  "[role=navigation],[role=banner],[role=complementary],.nav,.menu,.sidebar,.comments," +
  ".advertisement,.ad,.cookie,.newsletter,.related,.share,.breadcrumb";

/* Pick the element most likely to hold the article.
 *
 * Not a full Readability port - that is thousands of lines. This is the 80%
 * version: prefer the semantic containers, and if none exist, take whichever
 * block has the most paragraph text. That last rule is what saves badly-built
 * sites, which is most of them. */
function pickMain(doc) {
  for (const sel of ["article", "main", '[role="main"]', ".post-content",
                     ".entry-content", ".article-body", "#content"]) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent || "").trim().length > 250) return el;
  }
  let best = doc.body, bestScore = 0;
  for (const el of doc.querySelectorAll("div,section")) {
    const paras = el.querySelectorAll("p");
    if (paras.length < 3) continue;
    const score = [...paras].reduce((a, p) => a + (p.textContent || "").trim().length, 0);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function toMarkdown(root) {
  const out = [];
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/^h[1-6]$/.test(tag)) {
        if (text) out.push("\n" + "#".repeat(+tag[1]) + " " + text + "\n");
      } else if (tag === "p") {
        if (text) out.push(text + "\n");
      } else if (tag === "li") {
        if (text) out.push("- " + text);
      } else if (tag === "blockquote") {
        if (text) out.push("> " + text + "\n");
      } else if (tag === "br") {
        out.push("");
      } else if (el.children.length) {
        walk(el);
      } else if (text && (tag === "span" || tag === "div")) {
        out.push(text + "\n");
      }
    }
  };
  walk(root);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(STRIP).forEach((el) => el.remove());

  const meta = (sel, attr = "content") => doc.querySelector(sel)?.getAttribute(attr)?.trim() || "";
  const title = meta('meta[property="og:title"]') || (doc.querySelector("title")?.textContent || "").trim();
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const htmlLang = doc.documentElement.getAttribute("lang") || "";

  const content = toMarkdown(pickMain(doc));
  return { title, description, content, htmlLang, url };
}

/* r.jina.ai returns a small header block then the body. Parse it rather than
 * dumping the header into the user's text. */
function parseJina(text, url) {
  const grab = (label) => {
    const m = new RegExp(`^${label}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim() : "";
  };
  const title = grab("Title");
  const published = grab("Published Time");
  const split = text.split(/^Markdown Content:\s*$/m);
  const content = (split.length > 1 ? split.slice(1).join("Markdown Content:") : text).trim();
  return { title, description: "", content, published, url, htmlLang: "" };
}

/* ────────────────────────────── the fetcher ───────────────────────────── */

async function tryDirect(url, signal) {
  const resp = await fetch(url, { signal, headers: { Accept: "text/html,*/*" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  if (html.trim().length < 200) throw new Error("response was effectively empty");
  return { ...parseHtml(html, url), via: "direct" };
}

async function tryJina(url, signal) {
  const resp = await fetch(JINA + url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (text.trim().length < 100) throw new Error("response was effectively empty");
  return { ...parseJina(text, url), via: "r.jina.ai" };
}

async function tryAllOrigins(url, signal) {
  const resp = await fetch(ALLORIGINS + encodeURIComponent(url), { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  if (html.trim().length < 200) throw new Error("response was effectively empty");
  return { ...parseHtml(html, url), via: "allorigins.win" };
}

/* r.jina.ai's markdown mode returns Title, URL Source and Published Time, but
 * NOT the meta description or the html lang attribute. The SEO audit wants
 * both. Asking for `x-respond-with: html` returns the raw page so they can be
 * read out of the head.
 *
 * This is a SECOND network call, so it only runs when the caller actually
 * needs the metadata (the SEO tab) and the first route did not already supply
 * it. A failure here is not fatal - the content is already in hand, and a
 * missing meta description is exactly what the audit is there to report. */
async function fetchMeta(url, signal) {
  const resp = await fetch(JINA + url, { signal, headers: { "x-respond-with": "html" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const doc = new DOMParser().parseFromString(await resp.text(), "text/html");
  const meta = (sel) => doc.querySelector(sel)?.getAttribute("content")?.trim() || "";
  return {
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    htmlLang: doc.documentElement.getAttribute("lang") || "",
  };
}

/* Fetch a page. Reports which route succeeded so the UI can tell the user
 * whether a third party saw the URL.
 *
 * `wantMeta` opts into the extra metadata call described above. */
export async function fetchPage(rawUrl, { onProgress = () => {}, signal, wantMeta = false } = {}) {
  const url = normaliseUrl(rawUrl);
  const attempts = [];

  const routes = [
    ["direct", tryDirect, "reading the site directly"],
    ["r.jina.ai", tryJina, "site blocked the direct read — using r.jina.ai"],
    ["allorigins.win", tryAllOrigins, "trying allorigins.win"],
  ];

  for (const [name, fn, message] of routes) {
    onProgress(message);
    try {
      const result = await fn(url, signal);
      if (!result.content || result.content.length < 120) {
        attempts.push(`${name}: fetched, but no article text could be extracted`);
        continue;
      }
      result.attempts = attempts;
      result.words = (result.content.match(/\S+/g) || []).length;

      if (wantMeta && !result.description && name !== "direct") {
        onProgress("reading the page metadata");
        try {
          const extra = await fetchMeta(url, signal);
          result.description = extra.description;
          result.htmlLang = result.htmlLang || extra.htmlLang;
        } catch (e) {
          if (e.name === "AbortError") throw e;
          // Not fatal. A missing meta description is a finding, not a failure.
          attempts.push(`metadata lookup: ${e.message}`);
        }
      }
      return result;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // A blocked cross-origin request surfaces as an opaque TypeError with no
      // detail - the browser deliberately withholds it. Say what it means
      // rather than showing the user "Failed to fetch".
      const why = e instanceof TypeError
        ? "blocked by the browser (the site sends no CORS header)"
        : e.message;
      attempts.push(`${name}: ${why}`);
    }
  }

  throw new FetchError(
    `Could not read ${url}.\n\n${attempts.map((a) => "  • " + a).join("\n")}\n\n` +
    "Sites behind Cloudflare, a login, or a paywall usually cannot be read this way. Paste the text instead.",
    attempts);
}

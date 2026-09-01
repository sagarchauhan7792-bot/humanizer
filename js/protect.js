// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* protect.js - things a rewrite is never allowed to change.
 *
 * The humanizer's job is to change wording. These are the spans and semantics
 * where changing the wording changes the MEANING, and where a model asked to
 * "make this sound more natural" will cheerfully do so.
 *
 * This matters most for health content, which is the main use for this tool.
 * Three failure modes, in increasing order of harm:
 *
 *   1. A number moves.        "500 mg" -> "500mg"        cosmetic, fine
 *   2. A unit is prettified.  "500 mg" -> "half a gram"  now it is a dosage error
 *   3. A hedge is dropped.    "may reduce risk by 30%" -> "reduces risk by 30%"
 *
 * The third is the dangerous one and it is the one models do most eagerly,
 * because hedged prose reads as weak and "improve this text" is understood as
 * "make it more confident". A tool that quietly strengthens medical claims is
 * worse than no tool.
 *
 * Everything here is pure string work. No API call, no model judgement - a
 * model cannot be the thing that checks whether the model dropped a hedge.
 */

/* ─────────────────────── protected spans ─────────────────────── */

export const SPAN_PATTERNS = {
  url:     { re: /https?:\/\/[^\s<>"')\]]+/g,                          label: "URL" },
  email:   { re: /[\w.+-]+@[\w-]+\.[\w.-]+/g,                          label: "email" },
  phone:   { re: /(?:\+91[\s-]?)?[6-9]\d{9}\b/g,                       label: "phone number" },
  dosage:  { re: /\d+(?:[.,]\d+)?\s*(?:mg|ml|mcg|gm|kg|g|IU|mmol|mIU)\b/gi, label: "dosage" },
  price:   { re: /(?:₹|Rs\.?|INR)\s*\d[\d,]*(?:\.\d+)?/gi,             label: "price" },
  percent: { re: /\d+(?:\.\d+)?\s*%/g,                                 label: "percentage" },
  number:  { re: /\b\d+(?:[.,]\d+)*\b/g,                               label: "number" },
};

/* Order matters: the most specific pattern must claim a span first, or the
 * bare `number` rule swallows the digits out of "500 mg" and reports a plain
 * number where a dosage was meant. */
const SPAN_ORDER = ["url", "email", "phone", "dosage", "price", "percent", "number"];

/* Normalise for comparison, NOT for display.
 *
 * "500 mg" and "500mg" are the same dosage written two ways; flagging that as
 * a change would make the guard cry wolf on every rewrite and get switched
 * off. "500 mg" and "0.5 g" are NOT the same string and are deliberately
 * treated as different - a unit conversion in a dosage is exactly the silent
 * change worth catching. */
function canonical(kind, raw) {
  let s = raw.trim().toLowerCase();
  if (kind === "url") return s.replace(/[.,;:!?'"]+$/, "");
  if (kind === "dosage" || kind === "price" || kind === "percent") {
    return s.replace(/\s+/g, "").replace(/,/g, "").replace(/^rs\.?|^inr/, "₹");
  }
  if (kind === "number") return s.replace(/,/g, "");
  return s;
}

/* Pull every protected span out of a text, each claimed by exactly one rule. */
export function extractSpans(text) {
  const claimed = [];               // [start, end) ranges already taken
  const spans = [];
  const overlaps = (a, b) => claimed.some(([s, e]) => a < e && b > s);

  for (const kind of SPAN_ORDER) {
    const { re, label } = SPAN_PATTERNS[kind];
    for (const m of (text || "").matchAll(re)) {
      const start = m.index, end = m.index + m[0].length;
      if (overlaps(start, end)) continue;
      claimed.push([start, end]);
      spans.push({ kind, label, raw: m[0], canonical: canonical(kind, m[0]), start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/* Compare protected spans between two versions. */
export function compareSpans(before, after) {
  const a = extractSpans(before), b = extractSpans(after);
  const problems = [];

  for (const kind of SPAN_ORDER) {
    const mine = a.filter((s) => s.kind === kind);
    const theirs = b.filter((s) => s.kind === kind);
    const pool = theirs.map((s) => s.canonical);

    for (const span of mine) {
      const i = pool.indexOf(span.canonical);
      if (i === -1) {
        problems.push({
          kind, severity: kind === "number" ? "warn" : "error",
          detail: `${span.label} "${span.raw}" is missing from the rewrite.`,
        });
      } else {
        pool.splice(i, 1);                 // consume, so duplicates are counted
      }
    }
    // A leftover is only a problem if that value is absent from the SOURCE
    // entirely. Measured case: asked to keep "https://hiims.in", the model
    // rendered it as a markdown link [https://hiims.in](https://hiims.in) --
    // the same URL, now twice. Counting the duplicate as an invented URL would
    // reject a perfectly good rewrite. A genuinely NEW value is still caught.
    const sourceValues = new Set(mine.map((s) => s.canonical));
    for (const leftover of pool) {
      if (sourceValues.has(leftover)) continue;
      problems.push({
        kind, severity: kind === "number" ? "warn" : "error",
        detail: `A ${SPAN_PATTERNS[kind].label} appeared in the rewrite that was not in the source: "${leftover}".`,
      });
    }
  }
  return { ok: problems.every((p) => p.severity !== "error"), problems };
}

/* ──────────────────────────── hedges ──────────────────────────── */

/* Words that mark a claim as uncertain. Dropping one turns a qualified
 * statement into an assertion of fact. */
export const HEDGES = {
  en: ["may", "might", "could", "possibly", "reportedly", "appears to", "seems to",
       "suggests", "is associated with", "is linked to", "some studies", "preliminary",
       "in some cases", "generally", "typically", "often", "can help", "is thought to",
       "believed to", "potentially", "up to", "about", "approximately", "around"],
  hi: ["हो सकता है", "हो सकती है", "संभवतः", "शायद", "आमतौर पर", "कुछ मामलों में",
       "माना जाता है", "अध्ययनों के अनुसार", "लगभग", "करीब", "मदद कर सकता है"],
};

/* Verb pairs where the rewrite is allowed to swap within the pair (both are
 * hedged) but never to the bare indicative (which is not). */
const HEDGE_EQUIV = [
  ["may", "might", "could", "can"],
  ["suggests", "indicates", "points to"],
  ["is associated with", "is linked to", "correlates with"],
  ["appears to", "seems to"],
  ["approximately", "about", "around", "roughly"],
];

function hedgeClass(h) {
  const i = HEDGE_EQUIV.findIndex((g) => g.includes(h));
  return i === -1 ? h : `group:${i}`;
}

function countHedges(text, lang) {
  const list = HEDGES[lang] || HEDGES.en;
  const low = (text || "").toLowerCase();
  const found = {};
  for (const h of list) {
    // Word-boundary match so "may" does not fire inside "maybe" or "Mayo".
    const re = new RegExp(`(^|[^\\p{L}])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "giu");
    const n = (low.match(re) || []).length;
    if (n) found[h] = n;
  }
  return found;
}

/* Did the rewrite weaken the hedging?
 *
 * Compares by EQUIVALENCE CLASS, not by literal word: "may increase" ->
 * "might increase" is fine, "may increase" -> "increases" is not. */
export function checkHedges(before, after, lang = "en") {
  const a = countHedges(before, lang), b = countHedges(after, lang);
  const problems = [];

  const classTotals = (found) => {
    const t = {};
    for (const [h, n] of Object.entries(found)) {
      const c = hedgeClass(h);
      t[c] = (t[c] || 0) + n;
    }
    return t;
  };
  const ca = classTotals(a), cb = classTotals(b);

  for (const [cls, n] of Object.entries(ca)) {
    const after_n = cb[cls] || 0;
    if (after_n < n) {
      const words = cls.startsWith("group:")
        ? HEDGE_EQUIV[+cls.split(":")[1]].join(" / ")
        : cls;
      problems.push({
        kind: "hedge", severity: "error",
        detail: `Hedging was weakened: "${words}" appeared ${n} time(s) in the source but ${after_n} in the rewrite. A qualified claim must not become an assertion.`,
      });
    }
  }
  return { ok: !problems.length, problems, before: a, after: b };
}

/* ─────────────────────── claim strength ─────────────────────── */

/* Catch the specific pattern where a hedged claim about a NUMBER loses its
 * hedge: "may reduce risk by 30%" -> "reduces risk by 30%". The number
 * survives, so the span check passes; the meaning has still changed. */
const CLAIM_VERBS = ["reduce", "reduces", "increase", "increases", "improve", "improves",
  "cure", "cures", "prevent", "prevents", "lower", "lowers", "raise", "raises",
  "eliminate", "eliminates", "treat", "treats", "boost", "boosts"];

export function checkClaimStrength(before, after, lang = "en") {
  const problems = [];
  const hedgeWords = (HEDGES[lang] || HEDGES.en).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  // Find "<hedge> ... <claim verb>" within a short window in the source.
  const hedged = new RegExp(`(?:${hedgeWords})\\s+(?:\\w+\\s+){0,3}?(${CLAIM_VERBS.join("|")})\\b`, "gi");
  const seen = new Set();
  for (const m of (before || "").matchAll(hedged)) {
    const verb = m[1].toLowerCase();
    if (seen.has(verb)) continue;
    seen.add(verb);

    // Is that same verb now present WITHOUT a hedge in front of it?
    const bare = new RegExp(`(?:^|[.!?]\\s+)(?:(?!(?:${hedgeWords}))[\\w,'"() -]){0,60}?\\b${verb}\\b`, "i");
    const stillHedged = new RegExp(`(?:${hedgeWords})\\s+(?:\\w+\\s+){0,3}?${verb}\\b`, "i");
    if (bare.test(after || "") && !stillHedged.test(after || "")) {
      problems.push({
        kind: "claim", severity: "error",
        detail: `The claim around "${verb}" was hedged in the source but reads as an unqualified statement in the rewrite. Restore the qualifier.`,
      });
    }
  }
  return { ok: !problems.length, problems };
}

/* ───────────────────────── the full guard ───────────────────────── */

export function checkProtected(before, after, { lang = "en", glossary = [] } = {}) {
  const spans = compareSpans(before, after);
  const hedges = checkHedges(before, after, lang);
  const claims = checkClaimStrength(before, after, lang);

  const problems = [...spans.problems, ...hedges.problems, ...claims.problems];

  for (const g of (glossary || []).filter(Boolean)) {
    if (before.includes(g) && !after.includes(g)) {
      problems.push({ kind: "glossary", severity: "error", detail: `Protected term "${g}" was removed.` });
    }
  }

  const bw = (before.match(/\S+/g) || []).length;
  const aw = (after.match(/\S+/g) || []).length;
  if (bw && aw < bw * 0.7) problems.push({ kind: "length", severity: "error", detail: `Length fell from ${bw} to ${aw} words — content was cut.` });
  if (bw && aw > bw * 1.4) problems.push({ kind: "length", severity: "error", detail: `Length grew from ${bw} to ${aw} words — content was invented.` });

  const errors = problems.filter((p) => p.severity === "error");
  return {
    ok: errors.length === 0,
    problems,
    errors,
    warnings: problems.filter((p) => p.severity === "warn"),
    detail: errors.length
      ? errors.map((p) => p.detail).join(" ")
      : problems.length
        ? `No blocking defects. ${problems.length} minor note(s).`
        : "Protected spans, hedges, claim strength and glossary terms all intact.",
  };
}

/* Build the prompt fragment that tells the rewriter what it must not touch.
 * Listing the actual spans beats a general instruction: a model given the
 * literal string "500 mg" preserves it far more reliably than one told to
 * "preserve dosages". */
export function protectionInstructions(text, { lang = "en", glossary = [] } = {}) {
  const spans = extractSpans(text);
  const byKind = {};
  for (const s of spans) (byKind[s.kind] ||= new Set()).add(s.raw);

  const lines = [];
  for (const kind of SPAN_ORDER) {
    if (!byKind[kind]) continue;
    const items = [...byKind[kind]].slice(0, 25);
    lines.push(`  ${SPAN_PATTERNS[kind].label}s — reproduce EXACTLY, character for character: ${items.map((i) => `"${i}"`).join(", ")}`);
  }

  const hedges = Object.keys(countHedges(text, lang));
  if (hedges.length) {
    lines.push(`  hedges — these qualifiers MUST survive. Do not make any hedged claim sound more certain: ${hedges.slice(0, 20).map((h) => `"${h}"`).join(", ")}`);
    lines.push(`    You may swap a hedge for an equally uncertain one ("may" -> "might"). You may NOT drop it ("may increase" -> "increases").`);
  }
  for (const g of (glossary || []).filter(Boolean)) lines.push(`  protected term — reproduce exactly: "${g}"`);

  return lines.length
    ? `THINGS YOU MUST NOT CHANGE:\n${lines.join("\n")}\n\nNever convert a unit (500 mg must not become 0.5 g). Never round a number.`
    : "";
}

// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* detect.js - the public detector API.
 *
 * Picks the right signal set for the text, runs it, and returns one shape
 * regardless of language. Two separate detectors exist because the signals
 * that separate human from machine writing are NOT the same across scripts:
 * the English set scores paragraph rhythm and stock phrases, the Indic set
 * scores detokenisation artefacts and calques. Running either on the other's
 * language produces a number with no evidence behind it, so this module
 * refuses to do that.
 */

import * as EN from "./detect-en.js";
import * as INDIC from "./detect-indic.js";
import { SCRIPT_RANGES, LANGUAGES, BY_CODE } from "./languages.js";

/* Strip everything that is not prose before measuring anything.
 *
 * This exists because of a real failure: a BBC Hindi page loaded by URL, with
 * 10,334 Devanagari characters in it, was classified as ENGLISH. Fetched pages
 * arrive as markdown full of `![Image 1: caption](https://…)` and `[text](url)`,
 * and every character inside those URLs is a Latin letter. On a link-heavy page
 * the URLs alone outweigh the article.
 *
 * The same noise corrupts the Indic feature set: URLs would tank the
 * script-purity score and trigger a false "untranslated English left in place"
 * flag on a perfectly good Hindi article.
 *
 * So: keep link TEXT (that is prose the author wrote), drop link TARGETS, drop
 * bare URLs and code. Applied once at the entry point so every downstream
 * feature sees prose only.
 */
export function stripNoise(text) {
  return (text || "")
    .replace(/```[\s\S]*?```/g, " ")          // fenced code
    .replace(/`[^`\n]*`/g, " ")               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")    // images: caption is chrome, not prose
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  // links: keep the text, drop the target
    .replace(/<[^>]+>/g, " ")                 // stray html
    .replace(/https?:\/\/\S+/g, " ")          // bare urls
    .replace(/\S+@\S+\.\S+/g, " ")            // emails
    .replace(/[ \t]{2,}/g, " ");
}

/* Guess the language from the script alone.
 *
 * Script identifies the language unambiguously for Tamil, Telugu, Kannada,
 * Malayalam, Gujarati, Gurmukhi and Odia. It does NOT for Devanagari (Hindi,
 * Marathi, Nepali, Sanskrit, Konkani, Maithili, Dogri, Bodo all share it) or
 * for Bengali script (Bengali and Assamese). In those cases this returns the
 * most common language for the script and sets `ambiguous`, so the UI can
 * tell the user to confirm rather than silently assuming Hindi.
 */
export function detectLanguage(rawText) {
  const text = stripNoise(rawText);
  const letters = [...(text || "")].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return { code: "en", confidence: 0, ambiguous: false, note: "No letters found." };

  const tally = {};
  for (const c of letters) {
    const cp = c.codePointAt(0);
    for (const [script, [lo, hi]] of Object.entries(SCRIPT_RANGES)) {
      if (script === "Latin") continue;
      if (cp >= lo && cp <= hi) { tally[script] = (tally[script] || 0) + 1; break; }
    }
  }
  const latinCount = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  tally.Latin = latinCount;

  const [topScript, topCount] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const confidence = topCount / letters.length;

  if (topScript === "Latin") {
    // Latin script is either English or Hinglish. Romanised Hindi function
    // words are the cheapest reliable separator - no model needed.
    const low = (text || "").toLowerCase();
    const HINGLISH = ["hai", "hain", "nahi", "nahin", "aur", "kya", "kar", "ke liye",
      "karna", "wala", "bahut", "mein", "yeh", "woh", "aap", "hum", "kaise", "kyun"];
    const hits = HINGLISH.filter((w) => new RegExp(`(^|\\s)${w}(\\s|$|[,.!?])`).test(low)).length;
    if (hits >= 3) {
      return { code: "hinglish", confidence, ambiguous: false,
        note: `Romanised Hindi: matched ${hits} Hinglish function words.` };
    }
    return { code: "en", confidence, ambiguous: false, note: "Latin script, no Hinglish markers." };
  }

  const AMBIGUOUS = {
    Devanagari: { pick: "hi", also: ["mr", "ne", "sa", "kok", "mai", "doi", "brx"] },
    Bengali: { pick: "bn", also: ["as"] },
    Arabic: { pick: "ur", also: ["sd", "ks"] },
  };
  if (AMBIGUOUS[topScript]) {
    const { pick, also } = AMBIGUOUS[topScript];
    return {
      code: pick, confidence, ambiguous: true,
      note: `${topScript} is shared by several languages (${[pick, ...also].map((c) => BY_CODE[c].name).join(", ")}). Assuming ${BY_CODE[pick].name} - confirm if that is wrong.`,
    };
  }

  const lang = LANGUAGES.find((l) => l.script === topScript);
  return lang
    ? { code: lang.code, confidence, ambiguous: false, note: `${topScript} script identifies ${lang.name} uniquely.` }
    : { code: "en", confidence, ambiguous: false, note: "Script not recognised; falling back to English." };
}

/* Run the detector. Pass lang "auto" to detect it first. */
export function analyse(rawText, lang = "auto") {
  // Measure prose, not markup. See stripNoise above for the failure that
  // forced this: without it, a link-heavy Hindi page reads as English and its
  // script-purity score collapses.
  const text = stripNoise(rawText);

  let detected = null;
  if (lang === "auto") {
    detected = detectLanguage(text);
    lang = detected.code;
  }
  const report = lang === "en" ? EN.score(text) : INDIC.score(text, lang);
  report.detected = detected;
  report.lang_name = lang === "en" ? "English" : (BY_CODE[lang]?.name || lang);
  report.verdict = verdictFor(report);
  return report;
}

export function flagSentences(rawText, lang = "auto") {
  const text = stripNoise(rawText);
  if (lang === "auto") lang = detectLanguage(text).code;
  return lang === "en" ? EN.flagSentences(text) : INDIC.flagSentences(text, lang);
}

/* Verdict bands.
 *
 * Deliberately three bands, not two. A binary human/AI call implies a
 * confidence this instrument does not have, and the failure mode that matters
 * most - a human writer wrongly accused - comes from exactly that kind of
 * false precision. The middle band says "mixed signals", which is usually the
 * truthful answer for edited AI output or lightly-translated human writing.
 */
export function verdictFor(report) {
  const ai = report.ai_likeness;
  const short = report.n_words < 120;

  if (short) {
    return {
      label: "Too short to judge",
      band: "unknown",
      detail: `${report.n_words} words. The signals here are densities per 1000 words; below roughly 120 words a single phrase swings the result. Paste more text.`,
    };
  }
  if (ai <= 30) {
    return { label: "Reads as human-written", band: "human",
      detail: "None of the measured machine-writing signals are present at meaningful density." };
  }
  if (ai <= 60) {
    return { label: "Mixed signals", band: "mixed",
      detail: "Some measured signals are present. Consistent with AI output that a human has edited, or with human writing translated from English." };
  }
  return { label: "Reads as AI or machine-translated", band: "ai",
    detail: "Multiple measured signals are present at the densities seen in raw machine output." };
}

// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* detect-indic.js - Indic AI-likeness, reported as a PROXY.
 *
 * Read this before trusting any number it produces.
 *
 * No AI detector on the market is validated on Hindi, Marathi, Gujarati,
 * Bengali, Tamil, Telugu, Kannada, Malayalam, Odia or Punjabi. GPTZero and
 * Originality.ai are English-first and their Indic behaviour is unaudited.
 * Reporting one of their numbers on Devanagari text would be reporting noise
 * with a decimal point on it.
 *
 * So this module does not claim to be an AI detector. It measures four things
 * that are real, observable, and specific to Indic text, and reports the
 * inverse of the composite as "AI-likeness % (proxy)". The word proxy travels
 * with the number everywhere it is displayed.
 *
 * THE FOUR SCORED SIGNALS, measured native Hindi journalism vs raw MT, per 1k:
 *   space before punctuation   0.5  vs  29.8    detokenisation artefact
 *   prepositional calques      0.4  vs  10.7    "के रूप में" = literal "as"
 *   English relative clauses   0.4  vs   3.7    "जो...है" = literal "which is"
 *   comma density             22.0  vs  72.0    English punctuation rhythm
 *
 * Calibration on these four: AUC 1.00, Cohen's d 3.2, across three classes of
 * real text - native BBC Hindi (92.3), human-translated Wikipedia (74.7), raw
 * MT (56.0).
 *
 * WHAT IS NOT SCORED, AND WHY - see linguistics.js. Verb-finality and danda
 * usage were both tested and both failed; danda failed BACKWARDS. They are
 * still measured and shown as diagnostics so a user can see the evidence.
 *
 * Only Hindi has been calibrated with real fixtures. Every other language runs
 * the same code with the same bands, which is an EXTRAPOLATION. The UI labels
 * those results as uncalibrated. Do not quietly present them as equivalent.
 */

import { SCRIPT_RANGES, BY_CODE, CALIBRATED, SCRIPT_FAMILY } from "./languages.js";
import {
  AI_CONNECTIVES, CALQUES, FORMAL_MARKERS, HONORIFICS, VERB_ENDINGS,
  PREP_CALQUES, RELATIVE_MARKERS, forLang,
} from "./linguistics.js";

const SENT_SPLIT = /(?<=[.!?।॥])\s+/;

export function sentences(text) {
  return (text || "").split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function wordCount(text) {
  const m = (text || "").match(/\S+/g);
  return m ? m.length : 0;
}

function pstdev(xs) {
  if (!xs.length) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function countSub(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = hay.indexOf(needle);
  while (i !== -1) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/* Share of letters sitting inside the expected Unicode block. Catches text
 * that claims to be Tamil but is half Devanagari, and MT that leaves English
 * words untranslated. */
export function scriptRatio(text, script) {
  const rng = SCRIPT_RANGES[script];
  if (!rng) return 1;
  const [lo, hi] = rng;
  const letters = [...(text || "")].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => {
    const cp = c.codePointAt(0);
    return cp >= lo && cp <= hi;
  }).length / letters.length;
}

export function extract(text, lang = "hi") {
  text = (text || "").trim();
  const meta = BY_CODE[lang] || BY_CODE.hi;
  const family = SCRIPT_FAMILY[lang] || "hi";
  const words = Math.max(1, wordCount(text));
  const per1k = (n) => Math.round((n / (words / 1000)) * 100) / 100;
  const sents = sentences(text);
  const low = text.toLowerCase();

  // --- script and mechanics ----------------------------------------------
  const purity = scriptRatio(text, meta.script);
  const tokens = text.match(/\S+/g) || [];
  const latin = tokens.filter((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w)).length /
    Math.max(1, tokens.length);

  const spaceBeforePunct = (text.match(/\s+[,.।;:!?]/g) || []).length;
  const spacedHyphen = (text.match(/\s-\s/g) || []).length;
  const doubleSpace = (text.match(/ {2,}/g) || []).length;
  const noSpaceAfter = (text.match(/[,;:][^\s\d]/g) || []).length;
  const matraRun = (text.match(/[ा-ौ]{3,}/g) || []).length;
  const halantSpace = (text.match(/्\s/g) || []).length;

  // --- punctuation convention: MEASURED, NOT SCORED ----------------------
  const proseEnds = sents.map((s) => s.trim().slice(-1)).filter(Boolean);
  const dandaFrac = proseEnds.length
    ? proseEnds.filter((c) => c === "।" || c === "॥").length / proseEnds.length
    : 0;

  // --- word order: MEASURED, NOT SCORED ----------------------------------
  const verbs = forLang(VERB_ENDINGS, lang, family);
  let vf = 0, counted = 0;
  for (const s of sents) {
    const toks = s.replace(/[ .।॥!?]+$/, "").match(/\S+/g) || [];
    if (toks.length < 4) continue;
    counted += 1;
    const last = toks[toks.length - 1].replace(/^[ ,.।॥!?:;"'()]+|[ ,.।॥!?:;"'()]+$/g, "");
    if (verbs.some((v) => last.endsWith(v))) vf += 1;
  }
  const verbFinal = counted ? vf / counted : 1;

  // --- lexical tells: flagged, not scored --------------------------------
  const calques = forLang(CALQUES, lang, family).reduce((a, c) => a + countSub(low, c.toLowerCase()), 0);
  const connectives = forLang(AI_CONNECTIVES, lang, family).reduce((a, c) => a + countSub(low, c.toLowerCase()), 0);
  const formal = forLang(FORMAL_MARKERS, lang, family).reduce((a, w) => a + countSub(low, w.toLowerCase()), 0);

  // --- the four scored signals -------------------------------------------
  const relClause = forLang(RELATIVE_MARKERS, lang, family)
    .reduce((a, m) => a + (text.match(new RegExp(`(^|\\s)${escapeRe(m)}(\\s|$|[,।॥.])`, "g")) || []).length, 0);
  const prepCalque = forLang(PREP_CALQUES, lang, family)
    .reduce((a, p) => a + countSub(low, p.toLowerCase()), 0);
  const commas = countSub(text, ",") + countSub(text, "،");

  // --- variation ----------------------------------------------------------
  const lens = sents.map(wordCount).filter((n) => n > 1);
  const meanLen = mean(lens);
  const sentCv = lens.length > 2 && meanLen ? pstdev(lens) / meanLen : 0;

  const paras = text.split("\n").map(wordCount).filter((n) => n > 3);
  const paraCv = paras.length > 3 && mean(paras) ? pstdev(paras) / mean(paras) : 0;

  const r3 = (n) => Math.round(n * 1000) / 1000;
  return {
    words,
    n_sents: sents.length,
    purity: r3(purity),
    latin: r3(latin),
    danda_frac: r3(dandaFrac),
    mech_1k: per1k(spaceBeforePunct + doubleSpace + noSpaceAfter + matraRun + halantSpace),
    sp_punct_1k: per1k(spaceBeforePunct),
    hyphen_1k: per1k(spacedHyphen),
    verb_final: r3(verbFinal),
    calque_1k: per1k(calques),
    conn_1k: per1k(connectives),
    formal_1k: per1k(formal),
    rel_1k: per1k(relClause),
    prep_calque_1k: per1k(prepCalque),
    comma_1k: per1k(commas),
    mean_len: Math.round(meanLen * 10) / 10,
    sent_cv: r3(sentCv),
    para_cv: r3(paraCv),
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Bands are the measured class means: `good` is the native-Hindi mean,
 * `bad` is the raw-MT mean. All four are "lower is better", hence invert.
 * Weights are equal because all four separated cleanly and there is no
 * evidence to justify ranking them against each other. */
export const BANDS = {
  sp_punct_1k:    { good: 0.5,  bad: 29.8, invert: true, weight: 0.25 },
  prep_calque_1k: { good: 0.4,  bad: 10.7, invert: true, weight: 0.25 },
  rel_1k:         { good: 0.4,  bad: 3.7,  invert: true, weight: 0.25 },
  comma_1k:       { good: 22.0, bad: 72.0, invert: true, weight: 0.25 },
};

export const PARAM_LABEL = {
  sp_punct_1k: "No stray space before punctuation (detokenisation artefact)",
  prep_calque_1k: "Few prepositional calques (के रूप में / के द्वारा / के माध्यम से)",
  rel_1k: "Few English-shaped relative clauses (जो ... है)",
  comma_1k: "Comma density matches native prose, not English rhythm",
};

export const TARGET = 70.0;

function norm(value, good, bad, invert = false) {
  if (invert) { value = -value; good = -good; bad = -bad; }
  if (good === bad) return 100;
  return Math.max(0, Math.min(1, (value - bad) / (good - bad))) * 100;
}

export function score(text, lang = "hi") {
  const f = extract(text, lang);
  const meta = BY_CODE[lang] || BY_CODE.hi;
  const family = SCRIPT_FAMILY[lang] || "hi";

  const parameters = Object.entries(BANDS).map(([key, b]) => {
    const s = norm(f[key], b.good, b.bad, b.invert);
    return {
      key, label: PARAM_LABEL[key], value: f[key],
      score: Math.round(s * 10) / 10, passed: s >= TARGET, weight: b.weight,
    };
  });

  const composite = parameters.reduce((a, p) => a + p.score * p.weight, 0);

  // --- flags: real, actionable defects that do NOT move the score ---------
  const flags = [];
  const low = (text || "").toLowerCase();

  for (const phrase of forLang(CALQUES, lang, family)) {
    if (low.includes(phrase.toLowerCase())) {
      flags.push({ severity: "warn", kind: "calque", phrase,
        detail: "Literal rendering of an English construction. Grammatical, but not how the language is written." });
    }
  }
  for (const phrase of forLang(AI_CONNECTIVES, lang, family)) {
    const n = countSub(low, phrase.toLowerCase());
    if (n >= 2) {
      flags.push({ severity: "warn", kind: "connective", phrase,
        detail: `Used ${n} times. Generated prose leans on these discourse markers far harder than people do.` });
    }
  }
  const formalHits = forLang(FORMAL_MARKERS, lang, family).filter((w) => low.includes(w.toLowerCase()));
  if (formalHits.length >= 3) {
    flags.push({ severity: "note", kind: "register", phrase: formalHits.slice(0, 5).join(", "),
      detail: "Heavily Sanskritised vocabulary. Correct, but a marker of dictionary-driven translation and usually the wrong register for brand copy." });
  }

  // Honorific consistency: a real defect in customer-facing copy.
  const hon = HONORIFICS[lang] || HONORIFICS[family];
  if (hon) {
    const used = ["formal", "informal", "intimate"].filter(
      (lvl) => (hon[lvl] || []).some((p) => new RegExp(`(^|\\s)${escapeRe(p)}(\\s|$|[,।.])`).test(text)));
    if (used.length > 1) {
      flags.push({ severity: "error", kind: "honorific", phrase: used.join(" + "),
        detail: "Mixed politeness levels in one document. Pick one and hold it - readers notice this immediately." });
    }
  }

  if (f.purity < 0.85 && f.words > 30) {
    flags.push({ severity: "error", kind: "script",
      phrase: `${Math.round(f.purity * 100)}% ${meta.script}`,
      detail: `${Math.round((1 - f.purity) * 100)}% of letters fall outside the ${meta.script} block - usually untranslated English left in place.` });
  }

  // --- diagnostics: measured, deliberately unscored -----------------------
  const diagnostics = [
    { key: "verb_final", value: f.verb_final,
      note: "Verb-finality - TESTED AND FAILED. Native 0.921, human-translated 0.956, raw MT 0.906. Indic NMT gets word order right, so this separates nothing. Zero weight." },
    { key: "danda_frac", value: f.danda_frac,
      note: "Danda usage - TESTED AND FAILED BACKWARDS. BBC Hindi journalists end paragraphs with । in 0% of cases; Wikipedia and raw MT in ~98%. Scoring this would have penalised the most native text in the sample. Zero weight." },
    { key: "sent_cv", value: f.sent_cv,
      note: "Sentence-length variation - native sentences are LONGER than translated ones (22.5 vs 19.4 words), the opposite of the usual assumption. Not scored." },
    { key: "mech_1k", value: f.mech_1k,
      note: "All mechanical artefacts combined. Only the space-before-punctuation component is scored, since that is the part that was measured." },
  ];

  return {
    lang,
    calibrated: CALIBRATED.has(lang),
    script: meta.script,
    score: Math.round(composite * 10) / 10,
    ai_likeness: Math.round((100 - composite) * 10) / 10,
    parameters,
    flags,
    diagnostics,
    all_passed: parameters.every((p) => p.passed),
    n_words: f.words,
    features: f,
    method_note: CALIBRATED.has(lang)
      ? "Proxy score. Four signals calibrated on real Hindi text: native BBC Hindi (92.3), human-translated Wikipedia (74.7), raw MT (56.0). AUC 1.00, Cohen's d 3.2. Not a validated AI detector - none exists for Indic languages."
      : `Proxy score, UNCALIBRATED for ${meta.name}. The bands were measured on Hindi and are being extrapolated. The flags below are still literal matches and remain reliable; the number is indicative only.`,
  };
}

/* Sentence-level defects only. As in detect-en.js, no per-sentence score is
 * returned: the composite was calibrated on whole documents, and a single
 * sentence carries nowhere near enough statistical mass to support one. */
export function flagSentences(text, lang = "hi") {
  const family = SCRIPT_FAMILY[lang] || "hi";
  const calq = forLang(CALQUES, lang, family);
  const prep = forLang(PREP_CALQUES, lang, family);
  const conn = forLang(AI_CONNECTIVES, lang, family);

  return sentences(text).map((s, i) => {
    const low = s.toLowerCase();
    const hits = [];
    for (const p of prep) if (low.includes(p.toLowerCase())) hits.push({ type: "prep-calque", phrase: p });
    for (const p of calq) if (low.includes(p.toLowerCase())) hits.push({ type: "calque", phrase: p });
    for (const p of conn) if (low.includes(p.toLowerCase())) hits.push({ type: "connective", phrase: p });
    if (/\s+[,.।;:!?]/.test(s)) hits.push({ type: "mechanics", phrase: "space before punctuation" });
    return { index: i, text: s, hits };
  });
}

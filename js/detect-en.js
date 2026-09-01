// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* detect-en.js - English AI-likeness.
 *
 * Every constant below was MEASURED, not guessed: real BBC News articles
 * (n=8) against real Gemini output (n=8), two calibration rounds.
 *
 *   signal                    native    ai      separation
 *   paragraph-length CV        0.199   0.021       0.90   KEPT
 *   stock AI phrases /1k       0.000   1.686      -1.00   KEPT
 *   colon-led list scaffold    0.000   1.700      -1.00   KEPT
 *   passive-voice ratio        0.273   0.152       0.44   KEPT (sign reversed)
 *   em-dash density             1.83    1.66       0.10   DROPPED
 *   sentence-length CV          n/a     n/a        0.08   DROPPED
 *   vocabulary diversity        n/a     n/a        0.13   DROPPED
 *   repeated openings           n/a     n/a        0.00   DROPPED
 *   filler-phrase density       n/a     n/a        0.00   DROPPED
 *
 * Two findings worth stating plainly rather than quietly baking in:
 *
 *   EM-DASH OVERUSE is the most repeated piece of folk wisdom about LLM
 *   writing, and it looked real on the first round (separation -0.62). But
 *   that round compared single-paragraph AI fixtures against multi-paragraph
 *   BBC articles - a confound, not a finding. Re-run with AI fixtures written
 *   in matching multi-paragraph form, the signal collapsed to 0.10. Scoring
 *   it would penalise normal output for a habit it does not have.
 *
 *   PASSIVE VOICE runs the opposite way to the common claim: native writers
 *   here use MORE passive voice than the AI output, not less. Confirmed
 *   across both rounds (0.60, then 0.44). The sign below is what was measured.
 *
 * n=8/8 is a small sample and this composite has not been AUC-tested as
 * rigorously as the Hindi one. Treat it as a reasonable gate, not a settled
 * instrument.
 *
 * This is NOT a claim of parity with GPTZero, Originality.ai, Winston or
 * QuillBot. None of those has a usable free API. This measures what is
 * measurable for free, states what it measured, and never reports a number
 * for a check it did not run.
 */

const SENT_SPLIT = /(?<=[.!?])\s+/;

export const FILLER = [
  "it is important to note", "it should be noted", "in today's fast-paced",
  "in this day and age", "when it comes to", "at the end of the day",
  "needless to say", "it goes without saying", "the fact of the matter",
  "in order to", "due to the fact that", "a wide range of", "plays a vital role",
  "plays a crucial role", "in conclusion", "last but not least",
  "first and foremost",
];

export const AI_TELLS = [
  "moreover", "furthermore", "additionally", "in conclusion",
  "it is important to note", "delve into", "navigate the", "tapestry",
  "in the realm of", "unlock the", "harness the power", "in summary",
  "on the other hand", "as a result", "underscore", "testament to",
  "boasts a", "elevate your", "seamless", "robust", "cutting-edge",
];

const PASSIVE = /\b(?:is|are|was|were|be|been|being|get|gets|got)\s+(?:\w+ly\s+)?(\w+(?:ed|en|wn|ne))\b/gi;

export function sentences(text) {
  return (text || "").split(SENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

export function wordCount(text) {
  const m = (text || "").match(/\S+/g);
  return m ? m.length : 0;
}

function pstdev(xs) {
  if (!xs.length) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/* Count non-overlapping occurrences of a plain substring. */
function countSub(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function extract(text) {
  text = (text || "").trim();
  const words = Math.max(1, wordCount(text));
  const per1k = (n) => Math.round((n / (words / 1000)) * 100) / 100;
  const sents = sentences(text);
  const low = text.toLowerCase();

  // --- rhythm -------------------------------------------------------------
  const lens = sents.map(wordCount).filter((n) => n > 1);
  const meanLen = mean(lens);
  const sentCv = lens.length > 2 && meanLen ? pstdev(lens) / meanLen : 0;

  const paras = text.split("\n").map(wordCount).filter((n) => n > 3);
  const paraCv = paras.length > 3 && mean(paras) ? pstdev(paras) / mean(paras) : 0;

  // --- repeated openings --------------------------------------------------
  const openers = sents
    .filter((s) => s.split(/\s+/).length > 3)
    .map((s) => (s.match(/\S+/g) || []).slice(0, 2).join(" ").toLowerCase());
  const counts = {};
  for (const o of openers) counts[o] = (counts[o] || 0) + 1;
  const repOpen = openers.length
    ? Object.values(counts).filter((v) => v >= 3).reduce((a, b) => a + b, 0) / openers.length
    : 0;

  // --- lexical tells ------------------------------------------------------
  const fillerHits = FILLER.reduce((a, p) => a + countSub(low, p), 0);
  const tellHits = AI_TELLS.reduce((a, t) => a + countSub(low, t), 0);

  // Em dashes: measured, then dropped. Still reported for transparency.
  const emDash = countSub(text, "—") + countSub(text, " - ");

  // --- mechanics ----------------------------------------------------------
  const passive = (text.match(PASSIVE) || []).length;
  const passiveRatio = sents.length ? passive / sents.length : 0;

  const toks = low.match(/\S+/g) || [];
  const ttr = toks.length ? new Set(toks).size / toks.length : 0;

  // Colon-led list scaffolding ("Here's why: X, Y, and Z") - common in
  // generated copy.
  const colonLists = (text.match(/:\s*\w+.*?,\s*\w+.*?,\s*(?:and\s+)?\w+/g) || []).length;

  const r3 = (n) => Math.round(n * 1000) / 1000;
  return {
    words,
    n_sents: sents.length,
    mean_len: Math.round(meanLen * 10) / 10,
    sent_cv: r3(sentCv),
    para_cv: r3(paraCv),
    rep_open: r3(repOpen),
    filler_1k: per1k(fillerHits),
    tell_1k: per1k(tellHits),
    em_dash_1k: per1k(emDash),
    passive_ratio: r3(passiveRatio),
    ttr: r3(ttr),
    colon_lists_1k: per1k(colonLists),
  };
}

/* Weights and bands taken directly from the measured native/ai means above. */
export const WEIGHTS = {
  para_cv: 0.30, tell_1k: 0.30, colon_lists_1k: 0.25, passive_ratio: 0.15,
};

export const BANDS = {
  para_cv:        { good: 0.18, bad: 0.02 },
  tell_1k:        { good: 0.00, bad: 5.00, invert: true },
  colon_lists_1k: { good: 0.00, bad: 5.00, invert: true },
  passive_ratio:  { good: 0.28, bad: 0.04 },
};

export const PARAM_LABEL = {
  para_cv: "Paragraph rhythm varies (not uniform blocks)",
  tell_1k: "No stock AI phrasing (moreover / furthermore / delve into ...)",
  colon_lists_1k: "Not built from colon-led list scaffolding",
  passive_ratio: "Natural passive/active mix",
};

/* Each named parameter must individually clear this to count as passed. */
export const TARGET = 70.0;

/* Signals that were measured and found NOT to separate. Displayed so a user
 * can see they were tested, never folded into the score. */
export const DIAGNOSTIC = {
  em_dash_1k: "Em-dash density - tested, no signal (0.10). Folk wisdom, not data.",
  sent_cv: "Sentence-length variation - tested, no signal (0.08).",
  ttr: "Vocabulary diversity - tested, no signal (0.13).",
  rep_open: "Repeated sentence openings - tested, no signal (0.00).",
  filler_1k: "Filler-phrase density - tested, no signal (0.00).",
};

export function norm(value, good, bad, invert = false) {
  if (invert) { value = -value; good = -good; bad = -bad; }
  if (good === bad) return 100;
  const frac = (value - bad) / (good - bad);
  return Math.max(0, Math.min(1, frac)) * 100;
}

export const METHOD_NOTE =
  "Measured signals, calibrated against real BBC News text vs real Gemini " +
  "output (n=8/8). This is not a GPTZero or Originality.ai result - neither " +
  "has a usable free API. It is the honest free alternative, not a claim of " +
  "matching them.";

export function score(text) {
  const f = extract(text);
  const parameters = Object.entries(BANDS).map(([key, band]) => {
    const s = norm(f[key], band.good, band.bad, band.invert === true);
    return {
      key,
      label: PARAM_LABEL[key],
      value: f[key],
      score: Math.round(s * 10) / 10,
      passed: s >= TARGET,
    };
  });

  const composite = parameters.reduce((a, p) => a + p.score * WEIGHTS[p.key], 0);
  const diagnostics = Object.entries(DIAGNOSTIC).map(([key, note]) => ({
    key, value: f[key], note,
  }));

  return {
    lang: "en",
    calibrated: true,
    score: Math.round(composite * 10) / 10,
    ai_likeness: Math.round((100 - composite) * 10) / 10,
    parameters,
    diagnostics,
    all_passed: parameters.every((p) => p.passed),
    n_words: f.words,
    features: f,
    method_note: METHOD_NOTE,
  };
}

/* Per-sentence attribution, for highlighting in the UI.
 *
 * IMPORTANT: the composite above was calibrated on whole documents. A single
 * sentence has no paragraph rhythm and almost no statistical mass, so running
 * the document scorer on one sentence would produce a confident-looking number
 * that means nothing. Instead this returns only the DEFECTS that are locally
 * checkable - a stock phrase or a list scaffold is present or it is not - and
 * deliberately returns no score.
 */
export function flagSentences(text) {
  return sentences(text).map((s, i) => {
    const low = s.toLowerCase();
    const hits = [];
    for (const t of AI_TELLS) if (low.includes(t)) hits.push({ type: "tell", phrase: t });
    for (const p of FILLER) if (low.includes(p)) hits.push({ type: "filler", phrase: p });
    if (/:\s*\w+.*?,\s*\w+.*?,\s*(?:and\s+)?\w+/.test(s)) {
      hits.push({ type: "scaffold", phrase: "colon-led list" });
    }
    return { index: i, text: s, hits };
  });
}

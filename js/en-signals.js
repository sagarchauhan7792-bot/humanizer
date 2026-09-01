/* en-signals.js — the English signals the vendored detector cannot see.
 *
 * WHY THIS FILE EXISTS. A real document scored 8.8% ("reads as human-written")
 * here while QuillBot v7.1.0 called it 96% AI-generated. That was not a close
 * call, and the tool was the one that was wrong.
 *
 * The diagnosis, measured rather than guessed:
 *
 *   tell_1k        weight .30   value 0    score 100
 *   colon_lists_1k weight .25   value 0    score 100
 *   para_cv        weight .30   value 0.37 score 100
 *   passive_ratio  weight .15   value 0.07 score  13   <- the only one that fired
 *
 * FIFTY-FIVE PERCENT of the English weight is a keyword lookup against a list
 * of stock phrases ("moreover", "delve into", "tapestry"). The text contained
 * none of them, so both signals returned a perfect 100 by ABSENCE. Current
 * model prose, or prose a human lightly edited, simply does not use that 2023
 * vocabulary any more. The detector was measuring a fashion, and the fashion
 * moved.
 *
 * Measured across every labelled English fixture available (bhasha-seo's
 * _test/a1-a5 plus the QuillBot-confirmed document):
 *
 *   signal            AI mean   human    note
 *   nominal_1k          55.6     12.0    liver text 85.4 -- highest of all six
 *   contraction_1k       0.0      4.8    ZERO in all five AI fixtures
 *   person_1k           10.0     64.7    zero in two AI fixtures
 *   sent_cv            0.321    0.404    measured at 0.08 separation and
 *                                        dropped during the original English
 *                                        calibration; that looks wrong
 *   ai_likeness (current detector)
 *                       33.3     39.8    <- RANKS THE HUMAN SAMPLE AS MORE
 *                                           AI-LIKE THAN THE AI MEAN
 *
 * THAT LAST ROW IS THE POINT. It is the same failure shape as the AUC 0.21
 * first version of bhasha-seo's detector, and the fix then was measurement.
 *
 * SO WHY ARE THESE NOT SCORED? Because n_human = 1. One human sample cannot
 * set a band, and inventing numbers that look calibrated is precisely the
 * mistake CALIBRATION.md was written to prevent. These ship as OBSERVATIONS:
 * displayed, fed to the rewriter, counted as defects the loop may act on, and
 * carrying zero weight in any composite. The thresholds below are heuristics
 * chosen to sit in the measured gap, and they are labelled as such everywhere
 * they surface.
 *
 * To promote any of these to a scored band, collect >= 8 genuinely
 * human-written English documents of comparable length and register, re-run
 * the harness, and report the separation. Until then they stay unscored.
 *
 * This file exists rather than an edit to detect-en.js because that file is
 * vendored verbatim and its constants are pinned by a regression test.
 */

import { sentences, wordCount } from "./detect-en.js";

/* Sentence-initial adverbial and participial leads: "Based on this
 * evaluation,", "From an Ayurvedic perspective,", "Understanding the
 * patient's condition...". Human writing uses these; generated prose leans on
 * them to open almost every sentence. Measured 0.357 on the liver document
 * against <= 0.136 everywhere else. */
const LEAD = /^(based on|from an?|in light of|given|considering|regarding|in terms of|with regard|as (?:the|a)\b|through|by |when |while |following|understanding|overall|ultimately|importantly|notably|prompt|according to|due to|owing to|in addition|beyond)/i;

const NOMINAL = /(tion|ment|ance|ence|ity|ness|ency)s?$/;

/* A real contraction, not the possessive 's -- "the body's needs" is not one,
 * and counting it would wipe out the cleanest separation in the set. */
const CONTRACTION = /\b\w+'(?:t|re|ve|ll|d|m)\b/gi;

const PERSON = /\b(?:I|we|you|our|your|us|my|me|I'm|we're|you're)\b/g;

export function extractExtra(text) {
  const t = text || "";
  const sents = sentences(t);
  const toks = t.toLowerCase().match(/[a-z']+/g) || [];
  const n = Math.max(1, toks.length);
  const per1k = (x) => Math.round((x / (n / 1000)) * 10) / 10;

  const lens = sents.map(wordCount).filter((x) => x > 1);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length
    ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length)
    : 0;

  return {
    words: toks.length,
    n_sents: sents.length,
    sent_cv: lens.length > 2 && mean ? Math.round((sd / mean) * 1000) / 1000 : 0,
    nominal_1k: per1k(toks.filter((w) => w.length > 6 && NOMINAL.test(w)).length),
    contraction_1k: per1k((t.match(CONTRACTION) || []).length),
    person_1k: per1k((t.match(PERSON) || []).length),
    lead_frac: sents.length
      ? Math.round((sents.filter((s) => LEAD.test(s.trim())).length / sents.length) * 1000) / 1000
      : 0,
  };
}

/* Heuristic thresholds sitting in the measured gap. Deliberately conservative:
 * a false flag costs a wasted model call, and the loop's gates still police
 * whatever the model does about it. */
const RULES = [
  {
    key: "nominalisation",
    test: (f) => f.nominal_1k > 30,
    severity: "warn",
    label: (f) => f.nominal_1k + " nominalisations per 1000 words",
    detail: "Noun-heavy phrasing (evaluation, consumption, accumulation) where a verb would do. " +
      "Measured 55.6/1k across AI fixtures against 12.0 for the human one. Say who does what.",
    brief: "Cut noun-heavy phrasing. Prefer verbs: \"specialists evaluate\" over \"based on this " +
      "evaluation\", \"the liver stops working\" over \"cessation of hepatic function\".",
  },
  {
    key: "contractions",
    test: (f) => f.contraction_1k === 0 && f.words > 150,
    severity: "warn",
    label: () => "no contractions anywhere",
    detail: "All five AI fixtures measured contain exactly zero contractions; the human one had " +
      "4.8 per 1000 words. Uniformly expanded forms read as generated even when nothing else does.",
    brief: "Use contractions where a person naturally would (it's, doesn't, you'll). Not everywhere " +
      "— just stop avoiding them entirely.",
  },
  {
    key: "impersonal",
    test: (f) => f.person_1k < 5 && f.words > 150,
    severity: "warn",
    label: (f) => f.person_1k + " first/second-person words per 1000",
    detail: "The human fixture measured 64.7 per 1000 words; two AI fixtures measured zero. " +
      "Copy with no 'you' and no 'we' reads like a reference entry rather than something written " +
      "for a reader.",
    brief: "Address the reader directly where the copy is speaking to them. \"You may notice\" " +
      "rather than \"patients may experience\", where that is what is meant.",
  },
  {
    key: "adverbial-leads",
    test: (f) => f.lead_frac > 0.2 && f.n_sents > 5,
    severity: "warn",
    label: (f) => Math.round(f.lead_frac * 100) + "% of sentences open with an adverbial lead",
    detail: "\"Based on this…\", \"From an X perspective…\", \"Understanding the…\". Measured 35.7% " +
      "on the QuillBot-confirmed document against 4.3-13.6% elsewhere. Start more sentences with " +
      "their subject.",
    brief: "Stop opening sentences with participial and prepositional run-ups (\"Based on this " +
      "evaluation,\", \"From an Ayurvedic perspective,\"). Lead with the subject instead.",
  },
  {
    key: "uniform-rhythm",
    test: (f) => f.sent_cv < 0.3 && f.n_sents > 5,
    severity: "warn",
    label: (f) => "sentence-length variation " + f.sent_cv,
    detail: "Sentence lengths cluster tightly. This was measured at 0.08 separation during the " +
      "original English calibration and dropped; the fixtures here disagree (AI 0.321, human " +
      "0.404), which is why it is reported but still not scored.",
    brief: "Vary sentence length hard. Put a four-word sentence next to a twenty-five-word one.",
  },
];

export function extraFlags(text) {
  const f = extractExtra(text);
  return RULES.filter((r) => r.test(f)).map((r) => ({
    severity: r.severity,
    kind: r.key,
    phrase: r.label(f),
    detail: r.detail + "  (Observation, not a calibrated score — n_human=1.)",
    brief: r.brief,
    uncalibrated: true,
  }));
}

/* The honest verdict.
 *
 * `tell_1k` and `colon_lists_1k` carry 55% of the English weight between them
 * and are pure keyword lookups. When both are zero, more than half the score
 * was awarded for the ABSENCE of a specific vocabulary — which is not evidence
 * that a person wrote the text, only that it does not use a particular set of
 * words. Calling that "reads as human-written" is the false claim this file
 * exists to stop.
 */
export function verdictOverride(report, flags) {
  const byKey = Object.fromEntries(report.parameters.map((p) => [p.key, p]));
  const keywordOnly = (byKey.tell_1k?.value === 0) && (byKey.colon_lists_1k?.value === 0);

  if (!keywordOnly && !flags.length) return null;

  if (report.ai_likeness <= 30) {
    return {
      label: flags.length ? "Not judged human — unscored signals disagree" : "No stock AI vocabulary found",
      band: "mixed",
      detail: (keywordOnly
        ? "Over half this score was awarded for the ABSENCE of stock AI phrasing, which is not the " +
          "same as evidence a person wrote it. "
        : "") +
        (flags.length
          ? flags.length + " unscored signal(s) point the other way: " +
            flags.map((f) => f.phrase).join("; ") + ". "
          : "") +
        "A commercial detector reads distributional properties this tool cannot compute in a browser. " +
        "For English, check the number against a real detector before trusting it.",
    };
  }
  return null;
}

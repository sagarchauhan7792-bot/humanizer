/* rules.js — the deterministic, no-key humanizer.
 *
 * Runs FIRST on every request, before any model is called, and again on the
 * final output as cleanup. It is free, offline, idempotent, and it clears
 * exactly the signals a model handles worst — so the model's budget goes to
 * the signals only a model can move.
 *
 * WHAT IT WILL AND WILL NOT DO, and why that distinction is the whole point.
 *
 * The loop this file feeds chases a detector score. That makes every cheap
 * edit that moves a number without improving the text a live hazard, not a
 * hypothetical one. So each of the eight measured signals was classified by
 * whether it has a degenerate optimum, and this file only touches the ones
 * that do not:
 *
 *   sp_punct_1k   (Indic, w .25)  SOLVED. The fix is the correct fix.
 *   tell_1k       (EN,    w .30)  MOSTLY SOLVED, for the clauses where
 *                                 deletion is provably meaning-preserving.
 *   comma_1k      (Indic, w .25)  REFUSED beyond cosmetics — see below.
 *   prep_calque   (Indic, w .25)  ONE of three, behind an off-by-default flag.
 *   rel_1k        (Indic, w .25)  REFUSED — needs a parse.
 *   colon_lists   (EN,    w .25)  REFUSED — see COLON_REFUSAL.
 *   para_cv       (EN,    w .30)  REPORTED, never edited — see PARA_REFUSAL.
 *   passive_ratio (EN,    w .15)  Not chased anywhere in this tool.
 *
 * Honest ceiling: 1 of 4 Indic signals fully, 1 of 4 English signals roughly.
 * On raw MT that is worth a large share of the composite with no key and no
 * network. It cannot touch the other six without a syntactic parser or an
 * edit that games the metric, and it declines to do the second.
 */

import { mask, unmask } from "./guards.js";

/* ─────────────────── the refusals, stated in the UI ─────────────────── */

export const REFUSALS = [
  {
    key: "comma_1k",
    label: "Comma density",
    detail: "The safe mechanical subset (a comma before a danda, doubled commas) is cosmetic — " +
      "worth a couple of percent. The real fix is splitting comma-spliced sentences, and in a " +
      "verb-final language a regex cannot check that the second clause has its own finite verb. " +
      "Splitting blind produces fragments, so this is left to a model.",
  },
  {
    key: "rel_1k",
    label: "English-shaped relative clauses",
    detail: "Unpicking जो … है requires a parse. Deleting जो moves the number and yields " +
      "ungrammatical Hindi. Not attempted.",
  },
  {
    key: "colon_lists_1k",
    label: "Colon-led list scaffolding",
    detail: "The detector matches a literal colon. Swapping ':' for an em dash kills the match " +
      "without changing a single word, and em-dash density was measured and dropped from the " +
      "score, so nothing offsets it. That is a pure exploit and this pass will not do it. " +
      "Rewriting a colon-list into prose requires generating a verb — a model's job.",
  },
  {
    key: "para_cv",
    label: "Paragraph-length variation",
    detail: "A regex can merge and split paragraphs to hit any variance you name. It is the " +
      "purest metric-gaming lever in the set. This pass reports the figure and names candidate " +
      "paragraphs; it does not touch them.",
  },
  {
    key: "passive_ratio",
    label: "Passive voice",
    detail: "Not optimised anywhere in this tool. CALIBRATION.md records that its bands came " +
      "from long articles and that short text scores 0 regardless of who wrote it. Chasing it " +
      "means inserting passives to harvest points from a band the calibration record distrusts.",
  },
];

/* ───────────────────────── mechanics (all languages) ───────────────────────── */

/* The single highest-value free edit in the tool.
 *
 * Space-before-punctuation is a detokenisation artefact: native Hindi shows
 * 0.5 per 1000 words, raw MT shows 29.8 (detect-indic.js:176). It carries a
 * 0.25 weight and is pure mechanics — it cannot change meaning, so there is no
 * version of this edit that games the metric.
 *
 * The digit guard on the full-stop rule keeps "3 . 5" intact; everything else
 * ("word ,", "बात ।") is unambiguous. */
function fixSpaceBeforePunct(text) {
  let n = 0;
  let out = text.replace(/(\S)[ \t]+([,;:!?।॥])/g, (_, a, b) => { n += 1; return a + b; });
  out = out.replace(/([^\s.\d])[ \t]+\.(?=\s|$)/g, (_, a) => { n += 1; return a + "."; });
  return { text: out, count: n };
}

/* Cosmetic only, and labelled as such. A comma immediately before a danda is
 * always redundant; a doubled comma is always a typo. Neither is the real
 * comma-density fix — see REFUSALS. */
function fixCommaCosmetics(text) {
  let n = 0;
  const out = text
    .replace(/,\s*([।॥])/g, (_, d) => { n += 1; return d; })
    .replace(/,{2,}/g, () => { n += 1; return ","; })
    .replace(/,(\s*[)\]])/g, (_, b) => { n += 1; return b; });
  return { text: out, count: n };
}

/* ───────────────────────── English lexical tells ───────────────────────── */

/* Sentence-initial discourse markers. Deleting one of these and recapitalising
 * the next word is meaning-preserving in every case: they signal the relation
 * to the previous sentence, which the sentence order already carries.
 * Drawn from AI_TELLS / FILLER in detect-en.js:42-57. */
const OPENERS = [
  "moreover", "furthermore", "additionally", "in conclusion", "in summary",
  "notably", "importantly", "needless to say", "it goes without saying",
  "last but not least", "first and foremost", "at the end of the day",
];

/* Substitutions that are shorter and plainer but say the same thing. Each was
 * checked by hand for meaning preservation; anything arguable is in SUGGEST. */
const SUBS = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bdespite the fact that\b/gi, "although"],
  [/\bin the event that\b/gi, "if"],
  [/\ba wide range of\b/gi, "many"],
  [/\bas a result\b/gi, "so"],
  [/\bthe fact of the matter is that\b/gi, ""],
  [/\bit should be noted that\b/gi, ""],
  [/\bit is important to note that\b/gi, ""],
];

/* Flagged, never auto-applied. Deleting an adjective changes meaning; only a
 * writer can decide whether "robust" was carrying weight. */
const SUGGEST = [
  "tapestry", "seamless", "robust", "cutting-edge", "delve into", "navigate the",
  "in the realm of", "unlock the", "harness the power", "elevate your",
  "testament to", "boasts a", "underscore",
];

const CAP_AFTER = /(^|[.!?]["')\]]?\s+|\n\s*)/;

function stripOpeners(text) {
  let n = 0;
  let out = text;
  for (const phrase of OPENERS) {
    const rx = new RegExp(CAP_AFTER.source + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ",\\s+(\\S)", "gi");
    out = out.replace(rx, (_, lead, ch) => { n += 1; return lead + ch.toUpperCase(); });
  }
  return { text: out, count: n };
}

function applySubs(text) {
  let n = 0;
  let out = text;
  for (const [rx, to] of SUBS) {
    out = out.replace(rx, (m, ...rest) => {
      n += 1;
      if (to !== "") return to;
      // Deleting a lead-in leaves the next word lowercase mid-sentence-start.
      return "";
    });
  }
  // Recapitalise anything a deletion left starting lowercase, and tidy the
  // double spaces those deletions create.
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/(^|[.!?]["')\]]?\s+|\n\s*)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());
  return { text: out, count: n };
}

/* ───────────────────────── Hindi prepositional calques ───────────────────────── */

/* One of the three PREP_CALQUES (linguistics.js:158) has a mechanical
 * replacement that is reliably idiomatic:
 *
 *   के माध्यम से -> से        safe. "through X" -> the instrumental case.
 *   के द्वारा    -> ने        NOT SAFE. Changes case marking and interacts
 *                            with ergativity; wrong in most non-past clauses.
 *   के रूप में   -> (none)    no mechanical replacement exists.
 *
 * Ships Hindi-only and off by default, because "usually idiomatic" is not the
 * same as "always correct" and this is the one rule here that can be wrong. */
function fixPrepCalques(text, lang) {
  if (lang !== "hi") return { text, count: 0 };
  let n = 0;
  const out = text.replace(/\s*के\s+माध्यम\s+से/g, () => { n += 1; return " से"; });
  return { text: out, count: n };
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/* Deterministic and idempotent: applyRules(applyRules(x)) === applyRules(x).
 * test.html case 7 asserts exactly that, because a non-idempotent cleanup pass
 * run before AND after the model loop would keep editing on every call. */
export function applyRules(text, { lang = "en", aggressive = false } = {}) {
  const source = text || "";

  // Work on masked text so no rule can reach inside a URL, dosage or price.
  const { masked, map } = mask(source);

  const edits = [];
  let cur = masked;
  const step = (fn, rule, label) => {
    const r = fn(cur);
    cur = r.text;
    if (r.count) edits.push({ rule, label, count: r.count });
  };

  step(fixSpaceBeforePunct, "sp_punct_1k", "Removed stray space before punctuation");
  step(fixCommaCosmetics, "comma_1k", "Tidied redundant commas (cosmetic only)");

  if (lang === "en") {
    step(stripOpeners, "tell_1k", "Deleted sentence-opening discourse markers");
    step(applySubs, "tell_1k", "Replaced stock phrasing with plain wording");
  } else if (aggressive) {
    step((t) => fixPrepCalques(t, lang), "prep_calque_1k", "Replaced के माध्यम से with से");
  }

  const out = unmask(cur, map);

  // Flagged, not applied.
  const low = source.toLowerCase();
  const suggestions = SUGGEST
    .filter((p) => low.includes(p))
    .map((phrase) => ({
      phrase,
      detail: 'Stock AI vocabulary. Removing it changes meaning, so this pass will not do it for you — ' +
        'decide whether "' + phrase + '" is carrying weight here.',
    }));

  return {
    text: out,
    changed: out !== source,
    edits,
    suggestions,
    refusals: REFUSALS,
    note: edits.length
      ? "Deterministic pass: " + edits.reduce((a, e) => a + e.count, 0) + " edit(s), no model, no key, no network."
      : "Deterministic pass found nothing mechanical to fix.",
  };
}

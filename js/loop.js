/* loop.js — translate, then drive the score down without letting it lie.
 *
 * The accept/reject decision lives in guards.js. This file owns everything
 * around it: what the model is asked, which signals a pass is allowed to aim
 * at, how the objective is computed, and which pass wins.
 *
 * THREE DECISIONS WORTH KNOWING BEFORE EDITING
 *
 * 1. TWO SIGNALS ARE EXCLUDED FROM THE OBJECTIVE, on purpose.
 *
 *    passive_ratio (English, weight .15) is not chased. CALIBRATION.md records
 *    that its bands came from long articles and that short text scores 0
 *    "regardless of who wrote the text", and that it was deliberately not
 *    retuned. Chasing it means instructing a model to insert passive
 *    constructions to harvest 15 points from a band the calibration record
 *    itself distrusts. It stays in the REPORTED composite so numbers remain
 *    comparable with bhasha-seo, and is shown greyed in the UI.
 *
 *    So the English objective is renormalised over the other three:
 *    para_cv .353, tell_1k .353, colon_lists_1k .294. The Indic four keep
 *    their equal .25 weights, which is what they were calibrated with.
 *
 * 2. A REJECTION RETRIES; IT DOES NOT END THE RUN.
 *    bhasha-seo/js/humanize.js:254 breaks on the first non-accepted pass. That
 *    is right for a defect-driven loop, where a pass that fixes nothing means
 *    there is nothing left to fix. It is wrong here: a rejection usually means
 *    the model overreached on one attempt, and the next attempt at a different
 *    temperature often lands. The budget, not the first failure, ends the run.
 *
 * 3. THE WINNER IS THE BEST PASS, NOT THE LAST.
 *    Passes are a leaderboard. Pass 0 — the free deterministic rule pass — is
 *    always on it, so a run where every model pass is rejected still returns a
 *    real improvement rather than the raw input.
 *
 * UNCALIBRATED LANGUAGES CHANGE THE LOOP, not just the label. For the 21
 * languages that are neither Hindi nor English, the numeric bands are Hindi's
 * extrapolated, but the word lists are genuinely per-language — a text either
 * contains के रूप में or it does not. So acceptance there is driven by DEFECT
 * COUNT (literal matches, still true) and the composite is a read-out only.
 */

import * as EN from "./detect-en.js";
import * as INDIC from "./detect-indic.js";
import { analyse } from "./detect.js";
import { CALIBRATED, BY_CODE } from "./languages.js";
import { mask, unmask, runGates, gateDefects, words, MASK_RX } from "./guards.js";
import { applyRules } from "./rules.js";
import { generate, translateVia, extractText, looksLikeJsonEnvelope, BY_ID } from "./providers.js";
import { scoreLocal } from "./detectors.js";

/* ─────────────────────────── the objective ─────────────────────────── */

/* Excluded from the objective, present in the reported composite. */
export const NOT_CHASED = new Set(["passive_ratio"]);

export function objectiveWeights(lang) {
  if (lang === "en") {
    const kept = Object.entries(EN.WEIGHTS).filter(([k]) => !NOT_CHASED.has(k));
    const total = kept.reduce((a, [, w]) => a + w, 0);
    return Object.fromEntries(kept.map(([k, w]) => [k, Math.round((w / total) * 1000) / 1000]));
  }
  return Object.fromEntries(Object.entries(INDIC.BANDS).map(([k, b]) => [k, b.weight]));
}

/* Lower is better, same orientation as ai_likeness, so the two numbers the UI
 * shows side by side read the same way. */
export function objectiveOf(report) {
  const w = objectiveWeights(report.lang);
  let sum = 0, total = 0;
  for (const p of report.parameters) {
    if (w[p.key] === undefined) continue;
    sum += p.score * w[p.key];
    total += w[p.key];
  }
  if (!total) return report.ai_likeness;
  return Math.round((100 - sum / total) * 10) / 10;
}

/* Stable ids so a defect can be compared across passes. Both a failed scored
 * parameter and a literal flag count — gate 8 forbids trading either. */
export function defectIds(report) {
  const ids = new Set();
  for (const p of report.parameters) if (!p.passed) ids.add("param:" + p.key);
  for (const f of (report.flags || [])) ids.add("flag:" + f.kind + ":" + (f.phrase || ""));
  return ids;
}

/* Which signals is this pass allowed to aim at? Only ones that are actually
 * failing AND are in the objective. Gate 7 polices exactly this set, so a pass
 * cannot be punished for a degenerate edit to a signal nobody asked about. */
export function targetsFor(report) {
  const w = objectiveWeights(report.lang);
  return report.parameters.filter((p) => !p.passed && w[p.key] !== undefined).map((p) => p.key);
}

/* Goes through scoreLocal, not analyse, so the uncalibrated English
 * observations from en-signals.js land in `report.flags` and therefore in the
 * defect set the loop can act on. They still carry zero weight in `objective`. */
export function evaluate(text, lang) {
  const report = scoreLocal(text, lang).report;
  const defects = defectIds(report);
  return {
    report,
    objective: objectiveOf(report),
    aiPct: report.ai_likeness,
    defects,
    defectCount: defects.size,
    calibrated: report.lang === "en" || CALIBRATED.has(report.lang),
  };
}

/* ───────────────────────────── prompts ───────────────────────────── */

const MASK_RULE =
  "The text contains opaque tokens shaped like ⪉0⪊, ⪉1⪊ and so on. Each one stands for a " +
  "real number, dosage, price, percentage, URL, email or phone number that has been hidden from you " +
  "on purpose. Reproduce every token EXACTLY, once each, in a sensible place. Never invent a token, " +
  "never repeat one, and never write any digit of your own anywhere in the output. If a sentence " +
  "needs a figure, it already has a token for it.";

const OUTPUT_RULE =
  'Reply with JSON only: {"text": "<the full rewritten text>", "changes": ["<short note>", ...]}. ' +
  "No commentary outside the JSON.";

const SIGNAL_BRIEF = {
  sp_punct_1k: "Never put a space before a comma, danda, colon or question mark. This is a machine " +
    "detokenisation artefact and it is the single loudest tell in Indic text.",
  prep_calque_1k: "Stop using prepositional calques of English (के रूप में, के द्वारा, के माध्यम से). " +
    "Use the case marking the language actually uses.",
  rel_1k: "Stop mirroring English relative clauses (जो ... है). Native prose splits these into " +
    "separate statements far more often than it embeds them.",
  comma_1k: "Cut comma density hard — native prose uses roughly a third as many commas as English " +
    "rhythm produces. Do it by SPLITTING long sentences into shorter ones, not by deleting commas " +
    "and leaving run-ons. Deleting commas without adding sentences will be rejected.",
  tell_1k: "Remove stock connectives and AI vocabulary: moreover, furthermore, additionally, in " +
    "conclusion, delve into, tapestry, seamless, robust, cutting-edge, testament to. Say the thing " +
    "plainly instead.",
  colon_lists_1k: "Rewrite colon-led list scaffolding (\"Here is why: X, Y and Z\") into ordinary " +
    "sentences with real verbs. Do NOT simply swap the colon for a dash — that changes nothing.",
  para_cv: "Vary paragraph length the way a person does. Do NOT insert one-line stub paragraphs to " +
    "manufacture variation; that will be rejected.",
};

/* Flags carry their own instruction (en-signals.js `brief`). This is how the
 * uncalibrated English observations reach the rewriter without ever touching a
 * score: they tell the model what to fix, and the gates still police the
 * result. */
const flagBriefs = (flags) =>
  (flags || []).filter((f) => f.brief).map((f) => f.brief);

/* The retry variation for Anthropic, which rejects `temperature` outright. The
 * other providers get a rising temperature from providers.js instead; a small
 * prompt nudge on every provider costs nothing and keeps attempts distinct. */
const ATTEMPT_NUDGE = [
  "",
  " The previous attempt was rejected. Change the sentence boundaries more than you did, not the vocabulary.",
  " Previous attempts were rejected. Restructure whole paragraphs this time, but keep every fact.",
  " Earlier attempts failed the integrity checks. Be conservative: make fewer, larger, safer changes.",
  " Last attempt. Make only the single highest-value change and leave everything else exactly as it is.",
];

export function humanizePrompt(maskedText, { lang, targeted, flags, attempt = 0, glossary = [] }) {
  const name = lang === "en" ? "English" : (BY_CODE[lang] || {}).name || lang;
  const jobs = targeted.map((k, i) => (i + 1) + ". " + (SIGNAL_BRIEF[k] || k)).join("\n");
  const flagLines = (flags || []).slice(0, 8)
    .map((f) => "- " + f.kind + ': "' + (f.phrase || "") + '" — ' + f.detail).join("\n");

  return [
    "You are editing " + name + " copy that reads as machine-produced. Fix its RHYTHM and PHRASING.",
    "Not its facts, not its structure, not its claims. This is attempt " + (attempt + 1) + "." +
      (ATTEMPT_NUDGE[Math.min(attempt, ATTEMPT_NUDGE.length - 1)] || ""),
    "",
    "EDIT. DO NOT REWRITE FROM SCRATCH.",
    "",
    "WHAT TO FIX, in priority order:",
    jobs || "1. Make the rhythm less uniform without changing any meaning.",
    flagLines ? "\nSPECIFIC PHRASES FLAGGED IN THIS TEXT:\n" + flagLines : "",
    "",
    "HARD CONSTRAINTS:",
    MASK_RULE,
    "- Add no facts. Remove no facts. Do not strengthen or weaken any claim: if the source says " +
      '"may reduce", the rewrite says "may reduce", never "reduces".',
    "- Keep the language " + name + ". Do not translate anything into English.",
    "- Keep every heading and the order of the blocks.",
    "- Stay within 10% of the current length.",
    glossary.length ? "- Reproduce these terms verbatim: " + glossary.join(", ") : "",
    "",
    OUTPUT_RULE,
    "",
    "TEXT:",
    maskedText,
  ].filter(Boolean).join("\n");
}

export function translatePrompt(maskedText, { from, to, register = "formal", glossary = [] }) {
  const src = from === "en" ? "English" : (BY_CODE[from] || {}).name || from;
  const tgt = to === "en" ? "English" : (BY_CODE[to] || {}).name || to;

  /* Written as the inverse of the detector's scored signals. The point is that
   * the translation should not create the artefacts the humanize pass would
   * then have to spend model calls removing. */
  return [
    "Translate the text below from " + src + " into " + tgt + ".",
    "",
    "Transcreate, do not transliterate. The result must read as though a " + tgt +
      " speaker wrote it, not as though it were converted from " + src + ".",
    "",
    "SPECIFICALLY AVOID, because these are the measured markers of machine translation:",
    "1. English comma rhythm. Use roughly a third as many commas as the source; split long " +
      "sentences instead of chaining clauses.",
    "2. Prepositional calques (के रूप में, के द्वारा, के माध्यम से and their equivalents). Use the " +
      "target language's own case marking.",
    "3. Mirrored relative clauses (जो ... है). Split them into separate statements.",
    "4. A space before any comma, danda, colon or question mark. Never.",
    "5. More than one discourse marker (moreover / furthermore / however) in the whole piece.",
    "6. Over-Sanskritised or dictionary-formal vocabulary where ordinary words exist.",
    "7. Mixed politeness levels. Hold one register throughout: " + register + ".",
    "",
    MASK_RULE,
    "Preserving a token means preserving the token. Magnitude and unit WORDS around it " +
      "(\"per cent\", \"million\", \"times\") must still be translated normally.",
    glossary.length ? "Reproduce these terms verbatim, untranslated: " + glossary.join(", ") : "",
    "",
    OUTPUT_RULE,
    "",
    "TEXT:",
    maskedText,
  ].filter(Boolean).join("\n");
}

/* ───────────────────────────── translate ───────────────────────────── */

export async function runTranslate({ text, from, to, provider, register = "formal", glossary = [], signal,
  generateFn = generate }) {
  if (!text || !text.trim()) throw new Error("Nothing to translate.");
  if (from === to) throw new Error("Source and target language are the same.");

  if (provider === "mymemory") {
    const out = await translateVia("mymemory", { text, from, to, signal });
    return {
      text: out, provider, lowQuality: true,
      note: "MyMemory is keyless machine translation with no transcreation. Expect the humanize pass " +
        "to have real work to do — this path exists so the tool functions before you add a key.",
    };
  }
  if (provider === "rules") throw new Error("The rule-based backend cannot translate. Pick a model, or MyMemory.");

  const { masked, map } = mask(text);
  const prompt = translatePrompt(masked, { from, to, register, glossary });

  /* Retried, because the failure being guarded against is a malformed reply
   * and a second attempt usually fixes it. Previously this path had NO checks
   * at all: a bad reply became the deliverable. */
  let last = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await generateFn(provider, { prompt, attempt, maxTokens: 8192, signal });
    const got = extractText(raw);
    if (!got.ok) { last = got.why; continue; }

    const outMasked = got.text;

    /* Belt and braces: even a "successful" extraction must not look like an
     * envelope. This is the check that would have caught the JSON that reached
     * a live detector. */
    if (looksLikeJsonEnvelope(outMasked)) {
      last = "The model's reply still looked like a JSON envelope rather than prose.";
      continue;
    }

    /* The translate path now gets the same figure protection the rewrite loop
     * has. A translation that drops a dosage or invents a number is exactly as
     * dangerous as a rewrite that does. */
    const tok = (masked.match(MASK_RX) || []).length;
    const back = (outMasked.match(MASK_RX) || []).length;
    if (tok !== back) {
      last = "The translation dropped or duplicated " + Math.abs(tok - back) +
        " protected value(s) (numbers, dosages, URLs).";
      continue;
    }

    return {
      text: unmask(outMasked, map), provider, changes: got.changes,
      lowQuality: false, repaired: Boolean(got.repaired), plain: Boolean(got.plain),
    };
  }
  throw new Error("Translation failed after two attempts. " + last);
}

/* ───────────────────────────── the loop ───────────────────────────── */

export const DEFAULTS = { target: 30, maxCalls: 5, minGain: 2.0, maxConsecutiveRejects: 2 };

/* `generateFn` is injectable for one reason only: test.html and test.mjs drive
 * the whole loop against scripted model output, so every gate is exercised
 * offline, deterministically, at zero API cost. Production never passes it. */
export async function runHumanize({
  text, lang = "auto", provider = "rules",
  target = DEFAULTS.target, maxCalls = DEFAULTS.maxCalls,
  glossary = [], aggressive = false, onProgress = () => {}, signal,
  generateFn = generate,
}) {
  if (!text || !text.trim()) throw new Error("Nothing to humanize.");

  const first = evaluate(text, lang);
  const resolved = first.report.lang;
  const calibrated = first.calibrated;

  /* Pass 0 — the deterministic rule pass. Free, offline, and it always runs,
   * so the model never spends a call on a stray space before a comma. */
  const rules = applyRules(text, { lang: resolved, aggressive });
  const passes = [];
  let current = text, currentEval = first;

  if (rules.changed) {
    const ev = evaluate(rules.text, resolved);
    const better = calibrated ? ev.objective < first.objective : ev.defectCount <= first.defectCount;
    passes.push({
      n: 0, kind: "rules", accepted: better, text: rules.text,
      objective: ev.objective, aiPct: ev.aiPct, defectCount: ev.defectCount,
      edits: rules.edits, detail: rules.note,
    });
    if (better) { current = rules.text; currentEval = ev; }
  } else {
    passes.push({
      n: 0, kind: "rules", accepted: false, text, objective: first.objective, aiPct: first.aiPct,
      defectCount: first.defectCount, edits: [], detail: rules.note,
    });
  }
  onProgress({ stage: "rules", passes: [...passes] });

  const modelUsable = provider !== "rules" && !(BY_ID[provider] || {}).translateOnly;
  if (!modelUsable || maxCalls <= 0) {
    return finish({ text, resolved, calibrated, first, current, currentEval, passes, rules, target, provider });
  }

  let rejectsInARow = 0;

  for (let call = 0; call < maxCalls; call += 1) {
    if (signal && signal.aborted) break;
    if (calibrated && currentEval.objective <= target) break;
    if (!calibrated && currentEval.defectCount === 0) break;

    const targeted = targetsFor(currentEval.report);
    if (!targeted.length && !currentEval.report.flags?.length) break;

    const { masked, map } = mask(current);
    const prompt = humanizePrompt(masked, {
      lang: resolved, targeted, flags: currentEval.report.flags, attempt: call, glossary,
    });

    let raw;
    try {
      raw = await generateFn(provider, { prompt, attempt: call, maxTokens: 8192, signal });
    } catch (e) {
      passes.push({ n: call + 1, kind: "model", accepted: false, rejectedBy: "provider", detail: e.detail || e.message });
      onProgress({ stage: "pass", passes: [...passes] });
      rejectsInARow += 1;
      if (rejectsInARow >= DEFAULTS.maxConsecutiveRejects) break;
      continue;
    }

    /* Same defect as the translate path had: `|| raw` would hand the gates a
     * JSON envelope to score. Gate 1 would usually catch it via the digits in
     * the braces, but "usually" is not a guarantee -- refuse it here instead. */
    const got = extractText(raw);
    if (!got.ok || looksLikeJsonEnvelope(got.text)) {
      passes.push({ n: call + 1, kind: "model", accepted: false, rejectedBy: "malformed reply",
        detail: got.ok ? "The reply looked like a JSON envelope rather than prose." : got.why });
      onProgress({ stage: "pass", passes: [...passes] });
      rejectsInARow += 1;
      if (rejectsInARow >= DEFAULTS.maxConsecutiveRejects) break;
      continue;
    }
    const j = { changes: got.changes };
    const candidateMasked = got.text;

    /* Gates 0-7. Structural, deterministic, and evaluated BEFORE any score. */
    const gate = runGates({
      original: text, predecessor: current, candidateMasked, originalMasked: masked,
      map, lang: resolved, glossary, targeted,
    });

    if (!gate.ok) {
      passes.push({
        n: call + 1, kind: "model", accepted: false,
        rejectedBy: "gate " + gate.gate + " (" + gate.name + ")", detail: gate.detail,
      });
      onProgress({ stage: "pass", passes: [...passes] });
      rejectsInARow += 1;
      if (rejectsInARow >= DEFAULTS.maxConsecutiveRejects) break;
      continue;
    }

    /* Gate 8 — defects may be removed, never traded. */
    const candEval = evaluate(gate.candidate, resolved);
    const g8 = gateDefects(currentEval.defects, candEval.defects);
    if (!g8.ok) {
      passes.push({
        n: call + 1, kind: "model", accepted: false,
        rejectedBy: "gate 8 (defect-trade)", detail: g8.detail,
      });
      onProgress({ stage: "pass", passes: [...passes] });
      rejectsInARow += 1;
      if (rejectsInARow >= DEFAULTS.maxConsecutiveRejects) break;
      continue;
    }

    /* Gate 9 — and only now is the score allowed to speak.
     *
     * English accepts on EITHER the objective moving or a defect clearing. It
     * has to: the scored English signals are largely keyword lookups that a
     * modern model's prose never trips, so a document can be obviously
     * machine-written and still score 100 on three of four. The observations
     * in en-signals.js are the only thing with anything to say about such a
     * text, and they are deliberately unscored — so they have to be able to
     * drive acceptance without being smuggled into the number. */
    const objGain = currentEval.objective - candEval.objective;
    const defGain = currentEval.defectCount - candEval.defectCount;
    const accepted = calibrated
      ? (objGain >= DEFAULTS.minGain || defGain >= 1)
      : defGain >= 1;
    const gain = calibrated ? Math.max(objGain, 0) : defGain;
    const threshold = calibrated ? DEFAULTS.minGain : 1;

    passes.push({
      n: call + 1, kind: "model", accepted,
      rejectedBy: accepted ? null : "gate 9 (no gain)",
      text: gate.candidate, objective: candEval.objective, aiPct: candEval.aiPct,
      defectCount: candEval.defectCount, changes: (j && j.changes) || [],
      detail: accepted
        ? (calibrated
          ? (objGain >= DEFAULTS.minGain
            ? "Improved the objective by " + objGain.toFixed(1) + " points, all gates clear."
            : "Cleared " + defGain + " unscored defect(s) with the objective unmoved, all gates clear.")
          : "Cleared " + defGain + " literal defect(s), all gates clear.")
        : (calibrated
          ? "Gates passed but the objective moved only " + gain.toFixed(1) +
            " points (needs " + threshold + "). Discarded rather than accept churn."
          : "Gates passed but no defect was cleared. Discarded."),
    });
    onProgress({ stage: "pass", passes: [...passes] });

    if (accepted) { current = gate.candidate; currentEval = candEval; rejectsInARow = 0; }
    else {
      rejectsInARow += 1;
      if (rejectsInARow >= DEFAULTS.maxConsecutiveRejects) break;
    }
  }

  return finish({ text, resolved, calibrated, first, current, currentEval, passes, rules, target, provider });
}

/* The winner is the BEST accepted pass, not the last one. Ties break toward
 * fewer defects, then toward the earlier pass — least drift from the source. */
function finish({ text, resolved, calibrated, first, currentEval, passes, rules, target, provider }) {
  const accepted = passes.filter((p) => p.accepted && typeof p.text === "string");

  let winner = null;
  for (const p of accepted) {
    if (!winner) { winner = p; continue; }
    const key = (x) => (calibrated ? x.objective : x.defectCount);
    if (key(p) < key(winner) - 1e-9) winner = p;
    else if (Math.abs(key(p) - key(winner)) < 1e-9 && p.defectCount < winner.defectCount) winner = p;
  }

  const output = winner ? winner.text : text;
  const finalEval = winner ? evaluate(output, resolved) : first;

  return {
    output,
    lang: resolved,
    langName: first.report.lang_name,
    calibrated,
    provider,
    target,
    before: { objective: first.objective, aiPct: first.aiPct, defectCount: first.defectCount, report: first.report },
    after: { objective: finalEval.objective, aiPct: finalEval.aiPct, defectCount: finalEval.defectCount, report: finalEval.report },
    reachedTarget: calibrated ? finalEval.objective <= target : finalEval.defectCount === 0,
    winner: winner ? winner.n : null,
    passes,
    ruleSuggestions: rules.suggestions,
    ruleRefusals: rules.refusals,
    words: words(output),
    local: scoreLocal(output, resolved),
    note: calibrated
      ? "The loop optimised a renormalised objective (passive voice deliberately excluded) and the " +
        "winner is the best-scoring pass, not the last."
      : "The bands behind this number were measured on Hindi and are extrapolated to " +
        first.report.lang_name + ". The loop therefore optimised LITERAL DEFECT COUNT, which stays " +
        "reliable, and treats the score as a read-out only.",
  };
}

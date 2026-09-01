/* guards.js — everything that protects the text from the loop.
 *
 * This tool deliberately chases a detector score. bhasha-seo's humanizer
 * refuses to (js/humanize.js:1-28, "Goodhart's law with an API bill") and it
 * was right to, given what it had. aeo-translator re-armed the same trigger
 * safely (run.py:189-325) by putting STRUCTURAL guards in front of it. This
 * file is that idea, ported.
 *
 * The rule the whole tool rests on:
 *
 *     The score chooses the direction and picks the winner.
 *     It is NEVER allowed to grant admission.
 *
 * A candidate clears gates 1-8 before its score is computed. Gate order is
 * fixed and evaluation short-circuits, so a high score can never rescue a
 * candidate that failed a gate -- the score is not consulted for a failed one.
 *
 * Two specific hardenings over bhasha-seo/js/humanize.js:
 *
 * 1. MASK, don't merely list. protect.js:259 lists the protected spans in the
 *    prompt and trusts the model. Here the model never sees a digit at all.
 *    That converts "did it invent a number?" from a judgement call into a
 *    string comparison: a digit run in the candidate that is not in the masked
 *    original is, unambiguously, invented.
 *
 * 2. Compare against the ORIGINAL, not only the predecessor. humanize.js:219
 *    checks each candidate against the last accepted pass. The set-based
 *    checks survive chaining, but the length band is a RATIO (protect.js:236).
 *    Three passes at 0.75x each land at 0.42x of the original and never trip
 *    it. A score-driven loop has a much stronger incentive to shorten, so
 *    every ratio gate here is evaluated against both.
 */

import { compareSpans, checkHedges, checkClaimStrength, extractSpans } from "./protect.js";
import * as EN from "./detect-en.js";
import * as INDIC from "./detect-indic.js";
import { BY_CODE } from "./languages.js";

/* ────────────────────────────── masking ────────────────────────────── */

/* Token shape borrowed from aeo-translator/patterns.py:198. The point of the
 * odd brackets is that no MT engine and no model emits them spontaneously, so
 * a surviving token is unambiguous and a mangled one is detectable. */
const OPEN = "⪉", CLOSE = "⪊";
export const MASK_RX = new RegExp(OPEN + "(\\d+)" + CLOSE, "g");

/* The zero of every digit block the tool's languages use. Each block is
 * contiguous, so the offset from its zero IS the digit value. */
const DIGIT_ZEROS = [0x30, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0660];

function digitValue(cp) {
  for (const z of DIGIT_ZEROS) if (cp >= z && cp <= z + 9) return cp - z;
  return -1;
}

/* Fold every script's digits to ASCII so 500 and ५०० compare equal, and split
 * the text into digit runs. Anything non-digit is a separator. */
function digitRuns(s) {
  const runs = [];
  let cur = "";
  for (const ch of (s || "")) {
    const v = digitValue(ch.codePointAt(0));
    if (v >= 0) cur += String(v);
    else if (cur) { runs.push(cur); cur = ""; }
  }
  if (cur) runs.push(cur);
  return runs;
}

/* Replace every protected span with an opaque token. Returns the masked text
 * and the map needed to put the real values back. */
export function mask(text) {
  const spans = extractSpans(text || "");
  if (!spans.length) return { masked: text || "", map: {} };

  const map = {};
  let out = "", cursor = 0, i = 0;
  for (const span of spans) {
    const token = OPEN + i + CLOSE;
    map[token] = span.raw;
    out += text.slice(cursor, span.start) + token;
    cursor = span.end;
    i += 1;
  }
  out += text.slice(cursor);
  return { masked: out, map };
}

export function unmask(text, map) {
  let out = text || "";
  for (const [token, value] of Object.entries(map || {})) {
    out = out.split(token).join(value);
  }
  return out;
}

/* Digit runs still loose in a masked text -- things no SPAN_PATTERN claimed,
 * e.g. the "19" in "COVID19", which \b\d+\b cannot match. These are legitimate
 * and must pass through; what gate 1 forbids is a NEW one. */
function residualDigits(maskedText) {
  return digitRuns((maskedText || "").replace(MASK_RX, " "));
}

/* ───────────────────────────── helpers ───────────────────────────── */

export const words = (t) => ((t || "").match(/\S+/g) || []).length;

export function sentenceCount(text, lang) {
  return (lang === "en" ? EN.sentences(text) : INDIC.sentences(text)).length;
}

export function commaCount(text) {
  return ((text || "").match(/[,،、]/g) || []).length;
}

export function paragraphs(text) {
  return (text || "").split(/\n+/).map((p) => p.trim()).filter(Boolean);
}

function multisetMissing(need, have) {
  const pool = [...have];
  const missing = [];
  for (const x of need) {
    const i = pool.indexOf(x);
    if (i === -1) missing.push(x); else pool.splice(i, 1);
  }
  return { missing, extra: pool };
}

/* ─────────────────────────── the gate chain ─────────────────────────── */

/* Each gate rejects with {ok:false, gate, name, detail}. Order is deliberate
 * and evaluation short-circuits: the cheap deterministic checks run before
 * anything that costs a scoring pass, and the score itself is gate 9, run by
 * loop.js only when this returns ok.
 *
 * `targeted` is the set of signal keys this pass was asked to move. Gate 7
 * only polices those, because the degenerate edit for a signal nobody aimed
 * at is not evidence of gaming.
 */
export function runGates({
  original,            // the text the run started from -- never moves
  predecessor,         // the last ACCEPTED text
  candidateMasked,     // raw model output, still masked
  originalMasked,      // the masked text handed to the model this pass
  map,
  lang = "en",
  glossary = [],
  targeted = [],
}) {
  /* Gate 0 -- shape. */
  if (!candidateMasked || !candidateMasked.trim()) {
    return { ok: false, gate: 0, name: "shape", detail: "The model returned nothing usable." };
  }

  const candidate = unmask(candidateMasked, map);

  /* Gate 1 -- placeholders and invented figures.
   *
   * The port of aeo-translator/run.py:262-270, and the regression that
   * test_rewrite_loop.py case 5 exists for: asked to sound more human, a model
   * added a statistic that was not in the source. Because the model worked on
   * masked text, that failure is now a string comparison. */
  const tok = multisetMissing(originalMasked.match(MASK_RX) || [], candidateMasked.match(MASK_RX) || []);
  if (tok.missing.length) {
    return {
      ok: false, gate: 1, name: "placeholder",
      detail: tok.missing.length + " protected value(s) were dropped: " +
        tok.missing.slice(0, 4).map((t) => map[t] || t).join(", ") + ".",
    };
  }
  if (tok.extra.length) {
    return {
      ok: false, gate: 1, name: "placeholder",
      detail: "The rewrite duplicated or invented " + tok.extra.length +
        " placeholder token(s). A protected value may not be repeated into a new claim.",
    };
  }
  const resid = multisetMissing(residualDigits(candidateMasked), residualDigits(originalMasked));
  if (resid.missing.length) {
    return {
      ok: false, gate: 1, name: "invented-figure",
      detail: "The rewrite introduced figure(s) absent from the source: " + resid.missing.slice(0, 4).join(", ") +
        ". Every real number was masked before the model saw it, so a new digit run can only have been invented.",
    };
  }

  /* Gate 2 -- protected spans, against the ORIGINAL. */
  const spanErrors = compareSpans(original, candidate).problems.filter((p) => p.severity === "error");
  if (spanErrors.length) {
    return { ok: false, gate: 2, name: "spans", detail: spanErrors[0].detail, problems: spanErrors };
  }

  /* Gate 3 -- meaning: hedges and claim strength, against the ORIGINAL.
   * A qualified claim must not quietly become an assertion of fact. */
  const hedges = checkHedges(original, candidate, lang);
  if (!hedges.ok) {
    return { ok: false, gate: 3, name: "hedge", detail: hedges.problems[0].detail, problems: hedges.problems };
  }
  const claims = checkClaimStrength(original, candidate, lang);
  if (!claims.ok) {
    return { ok: false, gate: 3, name: "claim", detail: claims.problems[0].detail, problems: claims.problems };
  }

  /* Gate 4 -- length, against BOTH. The second half is the fix for the
   * cumulative-drift hole described in this file's header. */
  const wOrig = words(original), wPrev = words(predecessor), wNew = words(candidate);
  if (wOrig) {
    const r = wNew / wOrig;
    if (r < 0.75 || r > 1.25) {
      return {
        ok: false, gate: 4, name: "length-original",
        detail: "Length drifted to " + Math.round(r * 100) + "% of the ORIGINAL (" + wOrig +
          " to " + wNew + " words). Allowed band is 75-125%.",
      };
    }
  }
  if (wPrev) {
    const r = wNew / wPrev;
    if (r < 0.85 || r > 1.15) {
      return {
        ok: false, gate: 4, name: "length-pass",
        detail: "This single pass changed length by " + Math.round((r - 1) * 100) + "% (" + wPrev +
          " to " + wNew + " words). Allowed band is -15% to +15%.",
      };
    }
  }

  /* Gate 5 -- locked terms, against the ORIGINAL. */
  for (const g of (glossary || []).map((s) => String(s).trim()).filter(Boolean)) {
    if (original.includes(g) && !candidate.includes(g)) {
      return { ok: false, gate: 5, name: "locked", detail: 'Locked term "' + g + '" was removed from the text.' };
    }
  }

  /* Gate 6 -- script purity may not collapse. Catches a "humanising" pass that
   * quietly reverts Indic text toward English. */
  if (lang !== "en") {
    const script = (BY_CODE[lang] || {}).script;
    if (script) {
      const before = INDIC.scriptRatio(original, script);
      const after = INDIC.scriptRatio(candidate, script);
      if (after < Math.min(before, 0.85) - 0.02) {
        return {
          ok: false, gate: 6, name: "script",
          detail: script + " purity fell from " + Math.round(before * 100) + "% to " + Math.round(after * 100) +
            "%. The rewrite is drifting back into English.",
        };
      }
    }
  }

  /* Gate 7 -- anti-degenerate edits.
   *
   * This gate exists purely because the loop chases a score. Each check names
   * a cheap edit that moves its signal without improving the text, and refuses
   * it. Only signals this pass TARGETED are policed. */
  const aim = new Set(targeted);

  if (aim.has("comma_1k")) {
    const dropped = commaCount(predecessor) - commaCount(candidate);
    if (dropped > 2) {
      const gained = sentenceCount(candidate, lang) - sentenceCount(predecessor, lang);
      if (gained < 0.4 * dropped) {
        return {
          ok: false, gate: 7, name: "comma-strip",
          detail: dropped + " commas removed but only " + gained + " new sentence(s). Native prose SPLITS long " +
            "sentences; deleting the commas alone just moves the metric.",
        };
      }
    }
  }

  if (aim.has("para_cv")) {
    const origParas = paragraphs(original).map(words);
    const newParas = paragraphs(candidate).map(words);
    const origMin = origParas.length ? Math.min.apply(null, origParas) : 0;
    const origMax = origParas.length ? Math.max.apply(null, origParas) : 0;
    const stub = newParas.find((n) => n < 15 && n < origMin);
    if (stub !== undefined) {
      return {
        ok: false, gate: 7, name: "para-stub",
        detail: "A " + stub + "-word paragraph was inserted (shortest in the source was " + origMin +
          "). Paragraph-length variance is trivially gamed by stub paragraphs, so this is refused.",
      };
    }
    const slab = newParas.find((n) => n > 120 && n > origMax);
    if (slab !== undefined) {
      return {
        ok: false, gate: 7, name: "para-slab",
        detail: "A " + slab + "-word paragraph was created (longest in the source was " + origMax +
          "). Merging paragraphs to spike variance is refused for the same reason.",
      };
    }
  }

  return {
    ok: true, gate: 9, name: "passed", candidate,
    detail: "All structural gates passed. The score may now be consulted.",
  };
}

/* Gate 8 needs both defect sets, which only loop.js can produce (it owns the
 * scorer calls). It lives here so the whole accept/reject decision is
 * reviewable in one file. A pass may REMOVE defects; it may never TRADE them. */
export function gateDefects(beforeIds, afterIds) {
  const introduced = [...afterIds].filter((d) => !beforeIds.has(d));
  if (introduced.length) {
    return {
      ok: false, gate: 8, name: "defect-trade",
      detail: "The rewrite introduced " + introduced.length + " new defect(s) while fixing others: " +
        introduced.slice(0, 3).join("; ") + ".",
    };
  }
  return { ok: true, gate: 8, name: "defects" };
}

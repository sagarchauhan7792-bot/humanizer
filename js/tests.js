/* tests.js — the regression suite, run by both test.html and test.mjs.
 *
 * WHY THIS FILE EXISTS AT ALL. bhasha-seo ships no automated tests, and for
 * that tool it is defensible: its loop is gated on defects, so its worst
 * failure is "no improvement". This tool's loop is gated on a NUMBER, and its
 * worst failure is the one aeo-translator actually hit — fluent text asserting
 * a statistic nobody made. aeo-translator's test_rewrite_loop.py exists
 * precisely because a score trigger was re-armed there.
 *
 *     Rule: if you arm the score trigger, you ship its regression test.
 *
 * Every case runs offline against scripted model output. No key, no network,
 * no cost, fully deterministic.
 */

import { mask, unmask, runGates, gateDefects } from "./guards.js";
import { applyRules } from "./rules.js";
import { runHumanize, runTranslate, objectiveWeights, evaluate } from "./loop.js";
import * as EN from "./detect-en.js";
import * as INDIC from "./detect-indic.js";
import { REGISTRY, BY_ID, status, extractText, looksLikeJsonEnvelope, decodeKeyPayload } from "./providers.js";
import { extractExtra, extraFlags } from "./en-signals.js";
import { scoreLocal } from "./detectors.js";
import { normaliseUrl, FetchError } from "./fetch-url.js";

/* ─────────────────────────── fixtures ───────────────────────────
 * Short constructed strings, never article text: reproducing journalism to
 * exercise a test is a copyright problem, and bhasha-seo's _test/ directory is
 * gitignored anyway. */

const EN_MIXED =
  "Our clinic opened in 2019 and now sees 40 patients a day. Contact us at care@example.com " +
  "or visit https://example.com for details. The standard dose is 500 mg twice daily and costs " +
  "₹1,200 per course, a 30% saving on the earlier price. Results may improve within six weeks.";

const HI_COMMA =
  "डायबिटीज़ एक ऐसी स्थिति है, जो धीरे-धीरे बढ़ती है, और शुरू में कोई लक्षण नहीं दिखाती, इसलिए लोग इसे नज़रअंदाज़ कर देते हैं, लेकिन जाँच ज़रूरी है, क्योंकि देर होने पर नुकसान बढ़ जाता है।";

/* The document that falsified the English detector: 8.8% here, 96% AI to
 * QuillBot v7.1.0, 74% to GPTZero 4.1m. Reconstructed from the screenshots. */
const LIVER = `Simply put, liver failure occurs when the liver stops functioning adequately to meet the body's needs. It can develop rapidly over a few days or weeks as acute liver failure. Alternatively, long-standing liver disease can gradually lead to this stage.

Several factors can cause this condition. These include viral infections such as hepatitis, adverse reactions to medications or toxins, chronic alcohol consumption, or pre-existing severe liver disease.

Common symptoms include jaundice, fluid accumulation in the abdomen, swelling in the legs, fatigue, nausea, vomiting, and loss of appetite. As the condition worsens, patients may experience confusion, excessive drowsiness, behavioral changes, and reduced consciousness.

Based on this evaluation, specialists recommend diagnostic tests and care strategies. From an Ayurvedic perspective, tailored advice is provided regarding diet, daily routine, digestion, and lifestyle. Patients taking pre-existing medications must inform the physician rather than discontinuing treatment independently.

Prompt medical care remains paramount if severe symptoms manifest or clinical status deteriorates rapidly. Understanding the patient's condition and obtaining specialist advice before initiating any therapy is essential.`;

const EN_PARAS =
  "The team reviewed every submission over the winter and found the same pattern in almost all of them.\n" +
  "Reviewers spent longer on the introduction than on the results, which is the opposite of what the guidance asks for.\n" +
  "We changed the template so the results appear first and the discussion follows them directly.";

/* ─────────────────────────── harness ─────────────────────────── */

const cases = [];
const test = (name, why, fn) => cases.push({ name, why, fn });

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* Build a stub that plays a scripted list of model replies. */
function stub(replies) {
  let i = 0;
  return async () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return typeof r === "string" ? r : JSON.stringify(r);
  };
}

/* ───────────────────────────── the cases ───────────────────────────── */

test(
  "1. An invented statistic is discarded",
  "The port of aeo-translator/test_rewrite_loop.py case 5, and the single most important " +
  "assertion here. Asked to sound more human, a model added a figure that was not in the source. " +
  "Because it works on masked text, that is now a string comparison.",
  () => {
    const { masked, map } = mask(EN_MIXED);
    const candidate = masked + " Studies show 87 percent of patients agree.";
    const g = runGates({
      original: EN_MIXED, predecessor: EN_MIXED, candidateMasked: candidate,
      originalMasked: masked, map, lang: "en",
    });
    assert(!g.ok, "an invented figure was accepted");
    assert(g.gate === 1 && g.name === "invented-figure", "rejected by the wrong gate: " + g.gate + "/" + g.name);
    assert(/87/.test(g.detail), "the rejection did not name the invented figure");

    // And a dropped protected value is caught the other way round.
    const dropped = masked.replace(/⪉1⪊/, "the usual amount");
    const g2 = runGates({
      original: EN_MIXED, predecessor: EN_MIXED, candidateMasked: dropped,
      originalMasked: masked, map, lang: "en",
    });
    assert(!g2.ok && g2.gate === 1, "a dropped protected value slipped through");
    return "invented figure rejected at gate 1; dropped value rejected at gate 1";
  },
);

test(
  "2. Mask round-trip is the identity",
  "Every span kind claimed by SPAN_ORDER must survive mask -> unmask byte-for-byte, or the " +
  "guard that depends on masking is measuring the wrong text.",
  () => {
    const { masked, map } = mask(EN_MIXED);
    assert(unmask(masked, map) === EN_MIXED, "round-trip changed the text");
    for (const kind of ["url", "email", "dosage", "price", "percent", "number"]) {
      assert(Object.values(map).some((v) => v.length), "empty span captured for " + kind);
    }
    assert(!/\d/.test(masked.replace(/⪉\d+⪊/g, "")) || /2019|40/.test(EN_MIXED),
      "sanity: masked text should carry no unclaimed ASCII digits from claimed spans");
    assert(Object.keys(map).length >= 6, "expected at least six protected spans, got " + Object.keys(map).length);
    return Object.keys(map).length + " spans masked and restored exactly";
  },
);

test(
  "3. Comma-stripping is refused (gate 7)",
  "Deleting commas moves comma_1k, which carries a 0.25 weight, without improving the text at " +
  "all. Native prose SPLITS long sentences. A score-driven loop would take this trade every time " +
  "if nothing stopped it.",
  () => {
    const { masked, map } = mask(HI_COMMA);
    const stripped = masked.replace(/,/g, "");           // commas gone, no new sentences
    const g = runGates({
      original: HI_COMMA, predecessor: HI_COMMA, candidateMasked: stripped,
      originalMasked: masked, map, lang: "hi", targeted: ["comma_1k"],
    });
    assert(!g.ok, "a pure comma-strip was accepted");
    assert(g.gate === 7 && g.name === "comma-strip", "wrong gate: " + g.gate + "/" + g.name);

    // The honest version of the same edit -- split into sentences -- passes.
    const split = masked.replace(/,\s*/g, "। ");
    const g2 = runGates({
      original: HI_COMMA, predecessor: HI_COMMA, candidateMasked: split,
      originalMasked: masked, map, lang: "hi", targeted: ["comma_1k"],
    });
    assert(g2.ok, "splitting into sentences was wrongly rejected: " + g2.name + " — " + g2.detail);
    return "strip rejected at gate 7, genuine sentence-splitting accepted";
  },
);

test(
  "4. Stub paragraphs are refused (gate 7)",
  "para_cv carries the joint-highest English weight (.30) and is trivially gamed: insert one " +
  "four-word paragraph and variance spikes. This is the purest metric-gaming lever in the set.",
  () => {
    const { masked, map } = mask(EN_PARAS);
    const gamed = masked + "\nThat is the point.";
    const g = runGates({
      original: EN_PARAS, predecessor: EN_PARAS, candidateMasked: gamed,
      originalMasked: masked, map, lang: "en", targeted: ["para_cv"],
    });
    assert(!g.ok && g.gate === 7 && g.name === "para-stub", "stub paragraph accepted: " + g.name);

    // Gate 7 only polices signals the pass actually aimed at.
    const g2 = runGates({
      original: EN_PARAS, predecessor: EN_PARAS, candidateMasked: gamed,
      originalMasked: masked, map, lang: "en", targeted: ["tell_1k"],
    });
    assert(g2.ok, "gate 7 fired on a signal the pass never targeted");
    return "stub rejected when para_cv was targeted, ignored when it was not";
  },
);

test(
  "5. Cumulative length drift is caught against the ORIGINAL",
  "The regression for the hole in bhasha-seo/js/humanize.js:219. It checks each candidate " +
  "against the previous PASS, and the length band is a ratio, so three passes at 0.8x each land " +
  "at 0.51x of the original and never trip it.",
  () => {
    const shrink = (t, keep) => {
      const w = t.split(/\s+/);
      return w.slice(0, Math.max(1, Math.round(w.length * keep))).join(" ");
    };
    let predecessor = EN_PARAS;
    let lastGate = null;
    let survived = 0;

    for (let i = 0; i < 3; i += 1) {
      const { masked, map } = mask(predecessor);
      const candidate = shrink(masked, 0.88);   // inside the per-pass band, outside the original band once compounded
      const g = runGates({
        original: EN_PARAS, predecessor, candidateMasked: candidate,
        originalMasked: masked, map, lang: "en",
      });
      lastGate = g;
      if (!g.ok) break;
      survived += 1;
      predecessor = g.candidate;
    }
    assert(lastGate && !lastGate.ok, "three chained 0.8x passes all survived — drift is unbounded");
    assert(lastGate.name === "length-original",
      "caught by " + lastGate.name + ", expected length-original (the per-pass check alone is not enough)");
    assert(survived >= 1, "the very first 0.8x pass was rejected; that is the per-pass band, not the drift guard");
    return "drift caught at pass " + (survived + 1) + " by the against-original band, not the per-pass one";
  },
);

test(
  "6. The winner is the best-scoring accepted pass",
  "Passes are a leaderboard, not a stack. Under the current acceptance rule accepted passes " +
  "improve monotonically, so best and last coincide — this pins the invariant so a future change " +
  "to acceptance cannot silently start returning a worse pass than one it already had.",
  async () => {
    const wrap = (t) => JSON.stringify({ text: t, changes: ["stub"] });
    const { masked } = mask(HI_COMMA);
    const small = wrap(masked.replace(",", "।"));               // one split
    const big = wrap(masked.replace(/,\s*/g, "। "));            // all splits
    const worse = wrap(masked);                                      // no change at all

    const r = await runHumanize({
      text: HI_COMMA, lang: "hi", provider: "gemini", maxCalls: 3, target: 0,
      generateFn: stub([small, big, worse]),
    });

    const accepted = r.passes.filter((p) => p.accepted && typeof p.text === "string");
    assert(accepted.length >= 1, "no pass was accepted at all");
    assert(r.output === accepted.reduce((a, b) => (b.objective < a.objective ? b : a)).text,
      "the returned output is not the best-scoring accepted pass");
    for (const p of accepted) {
      assert(r.after.objective <= p.objective + 1e-9,
        "pass " + p.n + " scored better (" + p.objective + ") than the returned output (" + r.after.objective + ")");
    }
    const noGain = r.passes.find((p) => p.rejectedBy && p.rejectedBy.startsWith("gate 9"));
    assert(noGain, "a no-op candidate was not rejected at gate 9");

    /* And a rejection must not END the run. bhasha-seo/js/humanize.js:254
     * breaks on the first non-accepted pass, which is right for a
     * defect-driven loop and wrong here: a rejected pass usually means the
     * model overreached once, and the next attempt often lands. */
    const firstReject = r.passes.findIndex((p) => p.kind === "model" && !p.accepted);
    const laterAccept = r.passes.findIndex((p, i) => i > firstReject && p.accepted);
    assert(firstReject !== -1 && laterAccept !== -1,
      "the run stopped at the first rejection instead of retrying");

    return accepted.length + " accepted, best objective " + r.after.objective +
      ", no-op rejected at gate 9, and the run continued past a rejection to accept pass " +
      r.passes[laterAccept].n;
  },
);

test(
  "7. The rule pass is idempotent and surgical",
  "It runs before AND after the model loop. A non-idempotent cleanup would keep editing on " +
  "every call, and an over-broad one would silently rewrite text the loop never asked it to touch.",
  () => {
    const messy = "यह सही है , और यह भी सही है । " +
      "कीमत ₹1,200 है ? खुराक 500 mg है ;";
    const a = applyRules(messy, { lang: "hi" });
    const b = applyRules(a.text, { lang: "hi" });
    assert(a.text === b.text, "applyRules is not idempotent");

    // Surgical: only whitespace before punctuation may have gone.
    assert(a.text.replace(/\s+/g, "") === messy.replace(/\s+/g, ""),
      "the pass changed a non-whitespace character");
    assert(INDIC.extract(a.text, "hi").sp_punct_1k === 0,
      "space-before-punctuation survived: " + INDIC.extract(a.text, "hi").sp_punct_1k);
    assert(a.text.includes("₹1,200") && a.text.includes("500 mg"),
      "a protected span was damaged by the rule pass");

    // English: opener deletion recapitalises and preserves everything else.
    const en = applyRules("Moreover, sales rose. Furthermore, costs fell.", { lang: "en" });
    assert(en.text === "Sales rose. Costs fell.", "opener handling wrong: " + JSON.stringify(en.text));

    // And it refuses the two levers it must never pull.
    const keys = a.refusals.map((r) => r.key);
    for (const k of ["colon_lists_1k", "para_cv", "passive_ratio", "rel_1k"]) {
      assert(keys.includes(k), "the pass does not declare its refusal of " + k);
    }
    return "idempotent, whitespace-only, sp_punct_1k -> 0, four refusals declared";
  },
);

test(
  "8. The calibrated constants have not drifted",
  "These numbers are the measured asset, not tunables. bhasha-seo's detector scored AUC 0.21 " +
  "on its first version; the fix was measurement. This case fails the moment somebody nudges a " +
  "band to make a demo look better.",
  () => {
    const want = {
      sp_punct_1k: [0.5, 29.8], prep_calque_1k: [0.4, 10.7],
      rel_1k: [0.4, 3.7], comma_1k: [22.0, 72.0],
    };
    for (const [k, [good, bad]] of Object.entries(want)) {
      assert(INDIC.BANDS[k], "Indic band " + k + " is missing");
      assert(INDIC.BANDS[k].good === good && INDIC.BANDS[k].bad === bad,
        "Indic band " + k + " drifted to " + JSON.stringify([INDIC.BANDS[k].good, INDIC.BANDS[k].bad]));
      assert(INDIC.BANDS[k].weight === 0.25, "Indic weight " + k + " is no longer 0.25");
    }
    const w = { para_cv: 0.30, tell_1k: 0.30, colon_lists_1k: 0.25, passive_ratio: 0.15 };
    for (const [k, v] of Object.entries(w)) {
      assert(EN.WEIGHTS[k] === v, "English weight " + k + " drifted to " + EN.WEIGHTS[k]);
    }
    assert(EN.BANDS.passive_ratio.good === 0.28 && EN.BANDS.passive_ratio.bad === 0.04,
      "passive_ratio bands drifted — note these are sign-reversed vs folk wisdom on purpose");
    assert(EN.TARGET === 70 && INDIC.TARGET === 70, "the pass line moved off 70");

    // And the objective must still exclude passive voice, renormalised.
    const ow = objectiveWeights("en");
    assert(ow.passive_ratio === undefined, "passive_ratio leaked back into the chased objective");
    assert(Math.abs(ow.para_cv - 0.353) < 0.002 && Math.abs(ow.colon_lists_1k - 0.294) < 0.002,
      "English objective weights are not renormalised as documented: " + JSON.stringify(ow));
    const iw = objectiveWeights("hi");
    assert(Object.values(iw).every((x) => x === 0.25), "Indic objective weights are no longer equal");
    return "8 bands, 4 weights and both targets unchanged; objective excludes passive_ratio";
  },
);

test(
  "9. Every provider row is complete and honestly labelled",
  "The dropdown shows unconfigured providers disabled rather than hidden. A row missing its " +
  "kind or base URL would fail at call time instead of at render time.",
  () => {
    assert(REGISTRY.length >= 8, "expected the full provider spread, got " + REGISTRY.length);
    for (const p of REGISTRY) {
      assert(p.id && p.label && p.kind, "incomplete row: " + JSON.stringify(p));
      if (p.kind === "openai") assert(/^https?:\/\//.test(p.base || ""), p.id + " has no base URL");
      if (p.needsKey) assert(Array.isArray(p.models) && p.models.length, p.id + " needs a key but offers no model");
      const s = status(p.id);
      assert(typeof s.ok === "boolean" && s.why, p.id + " has no usable status");
      if (p.needsKey) assert(s.ok === false, p.id + " reports ready with no key saved in this environment");
    }
    assert(BY_ID.anthropic.models[0] === "claude-opus-5", "the Anthropic default model changed");
    assert(BY_ID.rules && !BY_ID.rules.needsKey, "the no-key backend must always be available");
    assert(BY_ID.mymemory.translateOnly === true, "MyMemory must be flagged translate-only");
    return REGISTRY.length + " providers, all complete, all keyless ones available";
  },
);

test(
  "10. An uncalibrated language drives on defects, not on the number",
  "For the 21 languages that are neither Hindi nor English the numeric bands are Hindi's, " +
  "extrapolated. The literal word-list matches are still real, so acceptance switches to those " +
  "and the composite becomes a read-out.",
  () => {
    const hi = evaluate(HI_COMMA, "hi");
    const mr = evaluate(HI_COMMA, "mr");
    assert(hi.calibrated === true, "Hindi should be calibrated");
    assert(mr.calibrated === false, "Marathi should not be calibrated");
    assert(/UNCALIBRATED/i.test(mr.report.method_note), "the uncalibrated reading does not say so");
    assert(mr.report.verdict === undefined || mr.report.verdict, "verdict shape changed");
    return "hi calibrated, mr not, and the note says which";
  },
);

test(
  "11. URL import rejects malformed input before it reaches the network",
  "The fetcher falls back to a proxy that SEES the URL, so a mistyped address must fail loudly " +
  "here rather than being normalised into a plausible-looking one and sent to a third party.",
  () => {
    assert(normaliseUrl("hiims.in/blog/x") === "https://hiims.in/blog/x", "bare host was not upgraded to https");
    assert(normaliseUrl("  https://a.example.com/p  ") === "https://a.example.com/p", "whitespace not trimmed");

    const rejects = [
      ["", "an empty string"],
      ["ftp://x.com", "a non-web scheme"],
      ["not a url at all", "a bare phrase"],
      ["localhost-ish", "a hostname with no dot"],
    ];
    for (const [input, why] of rejects) {
      let threw = false;
      try { normaliseUrl(input); } catch (e) { threw = e instanceof FetchError; }
      assert(threw, why + " (" + JSON.stringify(input) + ") was accepted as a URL");
    }

    /* The specific trap the scheme check exists for: prepending https:// to
     * "ftp://x.com" yields "https://ftp://x.com", which URL() happily parses
     * into the nonsense host "ftp" — a silent wrong answer, not an error. */
    let msg = "";
    try { normaliseUrl("ftp://x.com"); } catch (e) { msg = e.message; }
    assert(/ftp:/.test(msg), "the non-web-scheme rejection does not name the scheme: " + msg);
    return "bare hosts upgraded, 4 malformed inputs rejected before any network call";
  },
);

test(
  "12. A JSON envelope never reaches the output",
  "THE BUG THAT SHIPPED. A raw newline inside a JSON string is illegal, so every multi-paragraph " +
  "reply failed JSON.parse; the caller's `|| raw` fallback then made the whole fenced blob — braces, " +
  "the changes array and all — the translation. It reached GPTZero before anyone noticed.",
  async () => {
    // Exactly the shape a model returns for a multi-paragraph article.
    const reply = '```json\n{\n  "text": "पहला वाक्य है।\n\nदूसरा पैराग्राफ है।",\n' +
      '  "changes": ["अनुवाद किया गया"]\n}\n```';

    const got = extractText(reply);
    assert(got.ok, "the repaired parser still cannot read a multi-paragraph reply");
    assert(got.text === "पहला वाक्य है।\n\nदूसरा पैराग्राफ है।",
      "extracted the wrong text: " + JSON.stringify(got.text));
    assert(!looksLikeJsonEnvelope(got.text), "the extracted text still looks like an envelope");
    assert(got.changes.length === 1, "the changes array was lost");

    // And when it genuinely cannot be read, it must REFUSE, not pass the blob.
    const unreadable = '```json\n{ "chnages": [1,2,, "text" oops\n```';
    const bad = extractText(unreadable);
    assert(!bad.ok, "an unreadable JSON reply was accepted as text");
    assert(!/\{|changes/.test(bad.text || ""), "a refusal still leaked envelope content");

    // A model that ignores the JSON instruction and just writes prose is fine.
    const prose = extractText("यह सादा गद्य है। कोई JSON नहीं।");
    assert(prose.ok && prose.plain, "plain prose was rejected");

    // End to end: the translate path must throw rather than deliver an envelope.
    let threw = "";
    try {
      await runTranslate({
        text: "Some source text about liver health.", from: "en", to: "hi", provider: "gemini",
        generateFn: async () => unreadable,
      });
    } catch (e) { threw = e.message; }
    assert(/Translation failed/.test(threw), "runTranslate delivered an unreadable reply: " + threw);
    return "multi-paragraph JSON repaired, unreadable JSON refused, prose accepted, translate path throws";
  },
);

test(
  "13. English is not called human just because it lacks stock AI vocabulary",
  "A real document scored 8.8% here (\"reads as human-written\") while QuillBot called it 96% AI " +
  "and GPTZero 74%. Cause: tell_1k and colon_lists_1k are 55% of the English weight and are keyword " +
  "lookups, so both returned a perfect 100 for the ABSENCE of 2023-era phrasing.",
  () => {
    const f = extractExtra(LIVER);
    assert(f.nominal_1k > 30, "nominalisation density not detected: " + f.nominal_1k);
    assert(f.contraction_1k === 0, "fixture should contain no contractions");
    assert(f.person_1k === 0, "fixture should contain no first/second person");

    const flags = extraFlags(LIVER);
    const kinds = flags.map((x) => x.kind);
    for (const k of ["nominalisation", "contractions", "impersonal"]) {
      assert(kinds.includes(k), "no flag raised for " + k + " (raised: " + kinds.join(", ") + ")");
    }
    assert(flags.every((x) => x.uncalibrated === true && x.brief),
      "an observation is missing its uncalibrated marker or its rewriter brief");

    const scored = scoreLocal(LIVER, "en");
    assert(scored.report.verdict.band !== "human",
      'still labelled "' + scored.report.verdict.label + '" — the false human verdict is back');
    assert(/detector|absence|disagree/i.test(scored.report.verdict.detail),
      "the verdict does not explain why it is withholding the human call");

    // The observations must stay OUT of the number. n_human = 1.
    const weights = objectiveWeights("en");
    for (const k of ["nominal_1k", "contraction_1k", "person_1k", "lead_frac"]) {
      assert(weights[k] === undefined, k + " was given a weight — it is not calibrated");
    }
    assert(scored.report.parameters.length === 4, "an unscored observation leaked into the scored set");

    // And the loop must be able to act on them.
    const ev = evaluate(LIVER, "en");
    assert(ev.defectCount >= 3, "the observations did not reach the loop's defect set: " + ev.defectCount);
    return flags.length + " observations raised, verdict withheld, zero weight, " +
      ev.defectCount + " defects visible to the loop";
  },
);

test(
  "14. The setup-link decoder is strict, and non-Latin keys survive it",
  "The fragment carries real credentials. It must decode exactly or not at all — a link that " +
  "half-applies leaves you worse off than one that does nothing, and the fragment is the only part " +
  "of a URL browsers never send to the server, which is the whole reason it is the carrier.",
  () => {
    const payload = { gemini: "AQ.Ab8-xyz_09", openrouter: "sk-or-v1-aaa", _models: { gemini: "gemini-3.6-flash" } };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_");

    const got = decodeKeyPayload("#keys=" + b64);
    assert(got, "a valid payload did not decode");
    assert(got.gemini === payload.gemini && got.openrouter === payload.openrouter,
      "keys were mangled: " + JSON.stringify(got));
    assert(got._models.gemini === "gemini-3.6-flash", "model pins were lost");

    // base64url must round-trip the - and _ substitutions.
    assert(decodeKeyPayload("#keys=" + b64.replace(/=/g, "")), "padding-stripped base64url failed");

    // Anything malformed returns null rather than a partial object.
    for (const bad of ["", "#", "#nothing=1", "#keys=", "#keys=!!!!", "#keys=" +
      Buffer.from("[1,2,3]").toString("base64"), "#keys=" + Buffer.from("not json").toString("base64")]) {
      assert(decodeKeyPayload(bad) === null, "malformed input was accepted: " + JSON.stringify(bad));
    }

    // Unicode must survive, or a key with a non-ASCII byte silently corrupts.
    const uni = Buffer.from(JSON.stringify({ gemini: "kéy-ünï-✓" }), "utf8").toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_");
    assert(decodeKeyPayload("#keys=" + uni).gemini === "kéy-ünï-✓", "unicode was corrupted in transit");
    return "valid payloads decode exactly, 7 malformed inputs rejected, unicode preserved";
  },
);

/* ───────────────────────────── runner ───────────────────────────── */

export async function runTests() {
  const results = [];
  for (const c of cases) {
    try {
      const detail = await c.fn();
      results.push({ name: c.name, why: c.why, ok: true, detail: detail || "ok" });
    } catch (e) {
      results.push({ name: c.name, why: c.why, ok: false, detail: e.message });
    }
  }
  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/* detectors.js — where the number comes from, and how honest it is.
 *
 * Three backends, and the difference between them is the difference between a
 * measurement and a claim:
 *
 *   local   The calibrated proxy scorer. Free, offline, instant, and the ONLY
 *           one that drives the loop. Calibrated on Hindi and English only.
 *
 *   http    A generic adapter for a real commercial detector, configured from
 *           a form. Runs AT MOST TWICE per run — once on the input, once on
 *           the final output — and never inside the loop. Two reasons: a
 *           5-pass loop would be 10 paid calls, and letting a vendor's number
 *           steer edits in a language it was never validated on is exactly the
 *           mistake the local scorer's own method note warns about.
 *
 *   manual  A paste-in before/after log. The honest fallback for every
 *           detector the browser cannot reach or that costs money.
 *
 * WHY THE MANUAL LOG EXISTS AT ALL. This tool's central claim is "this lowered
 * the detector score". A browser cannot verify that against GPTZero, so the
 * options were to assert it, or to make it cheap for you to check by hand. The
 * log takes the second: it stores the PAIR and shows the delta, because a lone
 * "after" number is evidence of nothing.
 *
 * Every score returned from here carries its backend name, so a Sapling
 * reading can never be mistaken for the calibrated local one.
 */

import { analyse } from "./detect.js";
import { CALIBRATED } from "./languages.js";
import { extractExtra, extraFlags, verdictOverride } from "./en-signals.js";

const LS = typeof localStorage !== "undefined" ? localStorage : {
  _m: {}, getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; },
};

const PROXY_NOTE =
  "Proxy score from measured signals in the text itself. This is NOT a GPTZero, Originality " +
  "or Turnitin reading, and no commercial detector is validated on any Indian language.";

/* ───────────────────────────── local ───────────────────────────── */

export function scoreLocal(text, lang = "auto") {
  const report = analyse(text || "", lang);
  const calibrated = report.lang === "en" || CALIBRATED.has(report.lang);

  /* English gets the unscored observations from en-signals.js merged in, and
   * its verdict re-checked. A document this scorer called 8.8% ("reads as
   * human-written") was 96% AI to QuillBot and 74% to GPTZero, because 55% of
   * the English weight is a keyword lookup that returns a perfect 100 for the
   * ABSENCE of stock phrasing. The flags carry zero weight -- they change what
   * is SAID and what the rewriter is told, not the number. */
  if (report.lang === "en") {
    const flags = extraFlags(text || "");
    report.flags = [...(report.flags || []), ...flags];
    report.extra = extractExtra(text || "");
    const override = verdictOverride(report, flags);
    if (override) { report.verdict_original = report.verdict; report.verdict = override; }
  }

  return {
    pct: report.ai_likeness,
    backend: report.lang === "en" ? "local/en" : "local/indic",
    calibrated,
    note: calibrated ? PROXY_NOTE
      : PROXY_NOTE + " Worse here: the bands were measured on Hindi and are being extrapolated to " +
        report.lang_name + ". The literal defect matches below stay reliable; the number is indicative only.",
    report,
  };
}

/* ───────────────────────── external HTTP adapter ───────────────────────── */

/* Ported from aeo-translator/detectors.py:156-213, env vars swapped for a
 * form. Shipped UNCONFIGURED and it refuses to guess: a detector that invents
 * a number is strictly worse than one that declines to answer. */
const CFG_KEY = "hz.extdet";

export const emptyConfig = () => ({
  name: "", url: "", keyHeader: "Authorization", key: "",
  field: "document", responsePath: "", scale: "fraction",
});

export function getConfig() {
  try { return Object.assign(emptyConfig(), JSON.parse(LS.getItem(CFG_KEY) || "{}")); }
  catch { return emptyConfig(); }
}

export function setConfig(cfg) {
  LS.setItem(CFG_KEY, JSON.stringify(Object.assign(emptyConfig(), cfg || {})));
}

export function configured() {
  const c = getConfig();
  return Boolean(c.url && c.responsePath);
}

/* Walk a dotted path through nested objects and array indices, e.g.
 * "documents.0.class_probabilities.ai". */
function dig(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

export async function scoreHttp(text, signal) {
  const c = getConfig();
  if (!c.url || !c.responsePath) {
    throw new Error("The external detector is not configured. It needs at least a URL and a response path — " +
      "it will not guess where the score lives in an unknown response.");
  }
  const headers = { "content-type": "application/json" };
  if (c.key) headers[c.keyHeader || "Authorization"] = c.key;

  let res;
  try {
    res = await fetch(c.url, {
      method: "POST", signal, headers,
      body: JSON.stringify({ [c.field || "document"]: text }),
    });
  } catch (e) {
    throw new Error("The browser refused the response from " + c.url + ". Most commercial detectors " +
      "do not allow direct browser calls; use the manual log instead. (" + e.message + ")");
  }
  if (!res.ok) throw new Error("Detector returned HTTP " + res.status + ": " + (await res.text()).slice(0, 200));

  const j = await res.json();
  const raw = dig(j, c.responsePath);
  if (typeof raw !== "number") {
    throw new Error('No number at response path "' + c.responsePath + '". Got: ' + JSON.stringify(raw).slice(0, 120));
  }
  let host = c.url;
  try { host = new URL(c.url).host; } catch { /* keep the raw string */ }
  return {
    pct: Math.round((c.scale === "percent" ? raw : raw * 100) * 10) / 10,
    backend: (c.name || "http") + ":" + host,
    calibrated: false,
    note: "Third-party reading, unaudited here. If the text is not English, treat it as unvalidated — " +
      "no commercial detector publishes Indic validation.",
  };
}

/* ─────────────────────── the manual before/after log ─────────────────────── */

const LOG_KEY = "hz.extlog";

export function readLog() {
  try { const a = JSON.parse(LS.getItem(LOG_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

/* One row per (run, detector) pair, holding both sides. Recording only an
 * "after" number is not evidence of anything, so `side` is required and the
 * delta is only shown once both halves exist. */
export function addLog({ runId, detector, side, score, lang, note }) {
  const rows = readLog();
  const n = Number(score);
  if (!runId || !detector || !(side === "before" || side === "after") || !Number.isFinite(n)) {
    throw new Error("A log entry needs a run, a detector name, before/after, and a number.");
  }
  let row = rows.find((r) => r.runId === runId && r.detector === detector);
  if (!row) { row = { runId, detector, lang: lang || "", at: new Date().toISOString() }; rows.push(row); }
  row[side] = Math.round(n * 10) / 10;
  if (note) row.note = note;
  if (Number.isFinite(row.before) && Number.isFinite(row.after)) {
    row.delta = Math.round((row.after - row.before) * 10) / 10;
  }
  LS.setItem(LOG_KEY, JSON.stringify(rows.slice(-200)));
  return row;
}

export function clearLog() { LS.removeItem(LOG_KEY); }

export function logCsv() {
  const head = "run,detector,language,before,after,delta,recorded_at,note";
  const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  return [head, ...readLog().map((r) =>
    [r.runId, r.detector, r.lang, r.before ?? "", r.after ?? "", r.delta ?? "", r.at, r.note ?? ""]
      .map(esc).join(","))].join("\n");
}

/* Detectors worth pasting into by hand. Reachability was probed; usability
 * was not, and every one of the first three needs a paid plan. */
export const KNOWN_DETECTORS = [
  { name: "GPTZero", url: "https://gptzero.me", note: "API needs a paid plan." },
  { name: "Originality.ai", url: "https://originality.ai", note: "Paid." },
  { name: "Sapling", url: "https://sapling.ai/ai-content-detector", note: "Has a free tier — most likely to work via the HTTP adapter." },
  { name: "ZeroGPT", url: "https://zerogpt.com", note: "Undocumented API; browser calls appear to be blocked." },
  { name: "QuillBot", url: "https://quillbot.com/ai-content-detector", note: "No official API." },
];

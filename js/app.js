/* app.js — DOM wiring only.
 *
 * Deliberately holds no scoring, no gates and no prompts. If a rule about how
 * text is judged ends up in this file it is in the wrong place: guards.js owns
 * the accept/reject decision, loop.js owns the objective and the prompts,
 * detectors.js owns where a number came from. This file moves strings between
 * those modules and the page.
 */

import { LANGUAGES, BY_CODE, CALIBRATED } from "./languages.js";
import { analyse, verdictFor, detectLanguage } from "./detect.js";
import { fetchPage, FetchError } from "./fetch-url.js";
import * as EN from "./detect-en.js";
import * as INDIC from "./detect-indic.js";
import { applyRules } from "./rules.js";
import { runHumanize, runTranslate, objectiveWeights, NOT_CHASED } from "./loop.js";
import * as P from "./providers.js";
import * as D from "./detectors.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* MyMemory has effectively no coverage for these, and a frontier model will
 * attempt them with quality nobody here has measured. Saying so beats a
 * confident-looking result. */
const THIN_COVERAGE = new Set(["sat", "brx", "mni", "doi", "ks", "kok", "mai", "sd"]);

const state = { runId: null, input: "", output: "", lang: "en", busy: null };

/* Set during boot by the optional keys.local.js import; read by renderSettings. */
let localKeyFile = { found: false, applied: [] };

/* ───────────────────── one-click key setup via #fragment ─────────────────────
 *
 * keys.local.js only works where that file exists, which is never the hosted
 * copy — and it must never exist there, because the repo is public. So the
 * hosted origin needs some other way to receive keys once, without typing.
 *
 * A URL fragment is the right carrier for exactly one reason: browsers do NOT
 * send it to the server. It never reaches GitHub, never lands in an access
 * log, and never appears in a referrer header. It lives only in the link you
 * hold — which makes that link exactly as secret as the keys inside it, so it
 * must be treated as a credential and never pasted anywhere public.
 *
 * It ALWAYS asks before writing. A link that silently rewrote a visitor's
 * stored keys would be an unpleasant thing to be able to send someone, and one
 * confirmation click is cheap for something done once per browser.
 *
 * The fragment is stripped from the address bar immediately either way, so the
 * keys do not linger in history or get copied out of the URL bar by accident.
 */

function applyKeysFromHash() {
  const payload = P.decodeKeyPayload(location.hash);
  if (!payload) return null;

  const names = Object.keys(payload).filter((id) => P.BY_ID[id] && payload[id]);
  if (!names.length) return null;

  const ok = window.confirm(
    "Load API keys into this browser for:\n\n  " +
    names.map((id) => P.BY_ID[id].label).join("\n  ") +
    "\n\nThey are saved in this browser only (" + location.origin + ") and sent only to those " +
    "providers. Nothing is uploaded anywhere.\n\nProceed?");

  // Strip the fragment either way, so the keys leave the address bar at once.
  history.replaceState(null, "", location.pathname + location.search);
  if (!ok) return null;

  for (const id of names) P.setKey(id, payload[id]);
  for (const [id, model] of Object.entries(payload._models || {})) P.setModel(id, model);
  return names;
}

/* ─────────────────────────── language pickers ─────────────────────────── */

function langOptions(select, { includeEnglish = true, selected } = {}) {
  select.innerHTML = "";
  const rows = [{ code: "en", name: "English", script: "Latin" }, ...LANGUAGES.filter((l) => l.code !== "en")];
  for (const l of rows) {
    if (!includeEnglish && l.code === "en") continue;
    const o = document.createElement("option");
    o.value = l.code;
    const cal = l.code === "en" || CALIBRATED.has(l.code);
    o.textContent = l.name + (l.native ? " · " + l.native : "") + (cal ? "  (calibrated)" : "  (bands extrapolated)");
    select.appendChild(o);
  }
  if (selected) select.value = selected;
}

function pairNote() {
  const from = $("from").value, to = $("to").value;
  const cal = to === "en" || CALIBRATED.has(to);
  const bits = [];

  if (from === to) bits.push("Same language on both sides, so nothing is translated — this is a rewrite pass only.");
  else bits.push("Translate " + nameOf(from) + " → " + nameOf(to) + ", then rewrite the result.");

  if (!cal) {
    bits.push("The bands behind the score were measured on Hindi and are an extrapolation for " +
      nameOf(to) + ". The loop will optimise literal defect count instead of the number, and no " +
      "verdict label is shown.");
  }
  if (THIN_COVERAGE.has(to) || THIN_COVERAGE.has(from)) {
    bits.push("No back-translation fixtures exist for this pair. Treat the output as a draft.");
  }
  $("pair-note").textContent = bits.join(" ");
}

const nameOf = (code) => (code === "en" ? "English" : (BY_CODE[code] || {}).name || code);

/* ─────────────────────────── provider picker ─────────────────────────── */

function fillProviders() {
  const sel = $("provider");
  const keep = sel.value;
  sel.innerHTML = "";
  for (const p of P.REGISTRY) {
    const s = P.status(p.id);
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label + " — " + s.why;
    // Disabled, never hidden: a hidden provider looks like it does not exist.
    o.disabled = !s.ok;
    sel.appendChild(o);
  }
  sel.value = keep && !sel.querySelector('option[value="' + keep + '"]:disabled') ? keep : "rules";
  if (!sel.value) sel.value = "rules";
}

/* Clicking a disabled row cannot fire a change event, so catch the attempt on
 * the container and send the user where the fix is. */
$("provider").addEventListener("mousedown", () => { fillProviders(); });
$("provider").addEventListener("change", () => {
  const p = P.BY_ID[$("provider").value];
  if (p && p.translateOnly) {
    $("run-status").textContent = p.label + " can translate but cannot rewrite — the offline pass will do the humanizing.";
  } else $("run-status").textContent = "";
});

/* ─────────────────────────── settings dialog ─────────────────────────── */

function renderSettings() {
  const list = $("prov-list");
  list.innerHTML = "";

  /* Keys are stored PER ORIGIN. This line exists because that fact is
   * invisible otherwise: the same tool served from localhost and from the
   * hosted URL keeps two entirely separate sets of keys, and an empty dialog
   * on one of them looks like a bug rather than the browser working normally. */
  const where = el("div", "warnbox");
  /* Report what is CONFIGURED, not what this boot happened to write. The file
   * defaults to not overwriting a key already in storage, so on every run after
   * the first it applies nothing -- and "loaded 0 providers" reads like a
   * failure when in fact everything is set. */
  const ready = P.REGISTRY.filter((p) => p.needsKey && P.hasKey(p.id));
  if (localKeyFile.viaLink) {
    where.textContent = ready.length + " provider(s) loaded from a setup link and saved to this " +
      "browser (" + location.origin + "): " + ready.map((p) => p.label).join(", ") +
      ". These persist across reboots — you only do this once per browser.";
  } else if (localKeyFile.found) {
    where.textContent = "keys.local.js found on this machine. " + ready.length +
      " provider(s) configured: " + ready.map((p) => p.label).join(", ") +
      (localKeyFile.applied.length ? " (" + localKeyFile.applied.length + " applied just now)" : "") +
      ". Origin: " + location.origin + ".";
  } else {
    where.textContent = "No keys.local.js here — expected on the hosted copy, and deliberate: " +
      "the repo is public and shipping keys to it would publish them. Enter a key once below and " +
      "this browser will remember it across reboots. Note that storage is PER ORIGIN, so " +
      location.origin + " keeps its own set, separate from any local copy you run.";
  }
  list.appendChild(where);
  for (const p of P.REGISTRY) {
    if (p.kind === "none") continue;
    const box = el("div", "prov");
    const head = el("div");
    head.appendChild(el("b", null, p.label));
    const s = P.status(p.id);
    head.appendChild(document.createTextNode(" "));
    head.appendChild(el("span", "badge " + (s.ok ? "ok" : "no"), s.why));
    box.appendChild(head);

    if (p.note) box.appendChild(el("p", "tiny", p.note));
    if (p.keyHelp) box.appendChild(el("p", "tiny", p.keyHelp));

    const row = el("div", "row");

    if (p.needsKey) {
      const f = el("div", "field");
      f.appendChild(el("label", null, "API key"));
      const inp = document.createElement("input");
      inp.type = "password";
      inp.value = P.getKey(p.id);
      inp.placeholder = "stored in this browser only";
      inp.addEventListener("change", () => { P.setKey(p.id, inp.value); renderSettings(); fillProviders(); });
      f.appendChild(inp);
      row.appendChild(f);
    }

    if (p.models) {
      const f = el("div", "field");
      f.appendChild(el("label", null, "Model"));
      const inp = document.createElement("input");
      inp.value = P.defaultModel(p.id);
      inp.setAttribute("list", "models-" + p.id);
      const dl = document.createElement("datalist");
      dl.id = "models-" + p.id;
      for (const m of p.models) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); }
      inp.addEventListener("change", () => P.setModel(p.id, inp.value));
      f.appendChild(inp); f.appendChild(dl);
      row.appendChild(f);
    }

    const tf = el("div", "field");
    tf.style.flex = "0 0 auto";
    tf.appendChild(el("label", null, " "));
    const btn = el("button", "ghost", "Test");
    const out = el("span", "tiny", "");
    btn.addEventListener("click", async () => {
      btn.disabled = true; out.textContent = " testing…";
      const r = await P.test(p.id);
      btn.disabled = false;
      out.textContent = r.ok
        ? " ok · " + r.ms + "ms · " + r.model
        : " " + (r.detail || "failed");
      out.style.color = r.ok ? "var(--good)" : "var(--bad)";
    });
    tf.appendChild(btn);
    row.appendChild(tf);
    box.appendChild(row);
    box.appendChild(out);
    list.appendChild(box);
  }
}

$("open-settings").addEventListener("click", () => { renderSettings(); $("settings").showModal(); });
$("settings-close").addEventListener("click", () => { $("settings").close(); fillProviders(); });
$("forget-all").addEventListener("click", () => {
  for (const p of P.REGISTRY) P.setKey(p.id, "");
  renderSettings(); fillProviders();
});

/* ─────────────────────────── tabs ─────────────────────────── */

for (const b of document.querySelectorAll('[role="tab"]')) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll('[role="tab"]')) {
      const on = o === b;
      o.setAttribute("aria-selected", String(on));
      $("pane-" + o.dataset.tab).classList.toggle("hidden", !on);
    }
  });
}

/* ─────────────────────────── rendering ─────────────────────────── */

function bandOf(pct) { return pct <= 30 ? "human" : pct <= 60 ? "mixed" : "ai"; }

function renderScores(node, { before, after, calibrated }) {
  node.innerHTML = "";
  const add = (label, value, cls) => {
    const s = el("div", "score" + (cls ? " " + cls : ""));
    s.appendChild(el("b", null, value));
    s.appendChild(el("span", null, label));
    node.appendChild(s);
  };
  if (calibrated) {
    add("AI-likeness before (proxy)", before.aiPct + "%", bandOf(before.aiPct));
    add("AI-likeness after (proxy)", after.aiPct + "%", bandOf(after.aiPct));
    add("Objective the loop optimised", before.objective + " → " + after.objective);
  } else {
    add("Literal defects before", String(before.defectCount));
    add("Literal defects after", String(after.defectCount));
    add("Score (read-out only)", before.aiPct + "% → " + after.aiPct + "%");
  }
}

function renderPasses(node, passes) {
  node.innerHTML = "";
  if (!passes.length) { node.appendChild(el("p", "tiny", "No passes ran.")); return; }
  for (const p of passes) {
    const d = el("div", "pass " + (p.accepted ? "ok" : "no"));
    const title = p.kind === "rules"
      ? "Pass 0 · offline deterministic pass"
      : "Pass " + p.n + " · model";
    const verdict = p.accepted ? "accepted" : ("discarded — " + (p.rejectedBy || "no change"));
    d.appendChild(el("b", null, title + " — " + verdict));
    if (p.detail) d.appendChild(el("p", null, p.detail));
    if (p.edits && p.edits.length) {
      d.appendChild(el("p", null, p.edits.map((e) => e.label + " (" + e.count + ")").join("; ")));
    }
    if (p.objective !== undefined) {
      d.appendChild(el("p", null, "objective " + p.objective + " · " + p.defectCount + " defect(s)"));
    }
    node.appendChild(d);
  }
}

/* The parameter table is where "measured but not chased" has to be visible,
 * or the two numbers above it look inconsistent. */
function renderParams(tbody, beforeReport, afterReport) {
  tbody.innerHTML = "";
  const w = objectiveWeights(beforeReport.lang);
  const afterBy = Object.fromEntries((afterReport ? afterReport.parameters : []).map((p) => [p.key, p]));
  for (const p of beforeReport.parameters) {
    const chased = w[p.key] !== undefined;
    const tr = el("tr", chased ? "" : "dim");
    tr.appendChild(el("td", null, p.label));
    tr.appendChild(el("td", "num", String(p.score)));
    tr.appendChild(el("td", "num", afterBy[p.key] ? String(afterBy[p.key].score) : "—"));
    tr.appendChild(el("td", "num", chased ? String(w[p.key]) : "not chased"));
    tr.appendChild(el("td", null, (afterBy[p.key] || p).passed ? "pass" : "below 70"));
    tbody.appendChild(tr);
  }
}

/* Signals that are measured and shown but carry no weight. They exist because
 * the scored English set missed a document two commercial detectors called AI,
 * and they stay unscored because there is one human fixture to calibrate on. */
function renderObservations(report) {
  const node = $("observations");
  const head = $("obs-head");
  node.innerHTML = "";
  const obs = (report.flags || []).filter((f) => f.uncalibrated);
  head.classList.toggle("hidden", !obs.length);
  if (!obs.length) return;

  const intro = el("div", "warnbox",
    "These carry ZERO weight in the score above and are not calibrated — one human fixture is not a " +
    "band. They are shown because the scored English signals are largely keyword lookups that modern " +
    "machine prose does not trip, and they are what the rewriter was told to fix.");
  node.appendChild(intro);

  for (const f of obs) {
    const d = el("div", "pass");
    d.appendChild(el("b", null, f.phrase));
    d.appendChild(el("p", null, f.detail));
    node.appendChild(d);
  }
}

function renderRefusals(node, refusals) {
  node.innerHTML = "";
  for (const r of refusals || []) {
    const d = el("div");
    d.appendChild(el("b", null, r.label));
    d.appendChild(el("p", "note", r.detail));
    node.appendChild(d);
  }
}

/* ─────────────────────────── URL import ───────────────────────────
 *
 * fetch-url.js tries a DIRECT read first and only proxies if the site blocks
 * it. That ordering is a privacy decision, so the route it actually used is
 * always reported here — never silently proxy.
 *
 * The fetched article is DATA, not instructions. It is written with .value,
 * never innerHTML, and nothing in it is executed. It may later be sent to the
 * user's chosen model as text to rewrite, which is why the About tab says so
 * plainly rather than burying it.
 */

const VIA_NOTE = {
  direct: "read straight from the site — no third party saw this URL",
  "r.jina.ai": "the site blocked a direct read, so r.jina.ai fetched it and saw this URL",
  "allorigins.win": "direct and r.jina.ai both failed; allorigins.win fetched it and saw this URL",
};

/* The page's own lang attribute is a hint, not an answer: it is routinely
 * wrong or missing, and plenty of Hindi blogs declare lang="en". The script
 * tally in detect.js is measuring the actual text, so it wins — but a
 * disagreement is worth showing rather than resolving silently. */
function languageOf(article) {
  const detected = detectLanguage(article.content);
  const declared = (article.htmlLang || "").split("-")[0].toLowerCase();
  const disagrees = declared && declared !== detected.code;
  return { code: detected.code, declared, disagrees };
}

async function importUrl({ urlInput, target, statusEl, onLang }) {
  const raw = urlInput.value.trim();
  if (!raw) { statusEl.textContent = "Enter a URL first."; return; }

  const btnText = statusEl.textContent;
  statusEl.style.color = "var(--faint)";
  statusEl.textContent = "loading…";

  try {
    const article = await fetchPage(raw, {
      onProgress: (msg) => { statusEl.textContent = msg + "…"; },
    });

    target.value = article.content;

    const lang = languageOf(article);
    if (onLang) onLang(lang.code);

    const bits = [];
    if (article.title) bits.push('"' + article.title + '"');
    bits.push(article.words + " words");
    bits.push(nameOf(lang.code) + " detected");
    if (lang.disagrees) bits.push('the page declares lang="' + lang.declared + '" — going with the script');
    bits.push(VIA_NOTE[article.via] || article.via);

    statusEl.textContent = bits.join(" · ");
    statusEl.style.color = article.via === "direct" ? "var(--good)" : "var(--warn)";
  } catch (e) {
    statusEl.style.color = "var(--bad)";
    statusEl.textContent = e instanceof FetchError
      ? e.message.replace(/\n+/g, " ")
      : (e.message || String(e));
  } finally {
    if (!statusEl.textContent) statusEl.textContent = btnText;
  }
}

$("fetch").addEventListener("click", () => importUrl({
  urlInput: $("url"), target: $("input"), statusEl: $("fetch-status"),
  onLang: (code) => { $("from").value = code; pairNote(); },
}));

$("score-fetch").addEventListener("click", () => importUrl({
  urlInput: $("score-url"), target: $("score-input"), statusEl: $("score-fetch-status"),
  onLang: (code) => { $("score-lang").value = code; },
}));

for (const [inputId, buttonId] of [["url", "fetch"], ["score-url", "score-fetch"]]) {
  $(inputId).addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $(buttonId).click(); }
  });
}

/* ─────────────────────────── the main run ─────────────────────────── */

function glossary() {
  return $("glossary").value.split(",").map((s) => s.trim()).filter(Boolean);
}

function setBusy(on, msg) {
  $("run").disabled = on;
  $("run-rules").disabled = on;
  $("cancel").classList.toggle("hidden", !on);
  $("run-status").textContent = msg || "";
}

async function doRun({ rulesOnly = false } = {}) {
  const text = $("input").value.trim();
  if (!text) { $("run-status").textContent = "Paste some text first."; return; }

  const from = $("from").value, to = $("to").value;
  const provider = rulesOnly ? "rules" : $("provider").value;
  const ctl = new AbortController();
  state.busy = ctl;
  setBusy(true, "working…");

  try {
    let working = text;

    if (from !== to && !rulesOnly) {
      setBusy(true, "translating " + nameOf(from) + " → " + nameOf(to) + "…");
      const tr = await runTranslate({
        text, from, to, provider, glossary: glossary(), signal: ctl.signal,
      });
      working = tr.text;
    } else if (from !== to && rulesOnly) {
      $("run-status").textContent = "The offline pass cannot translate — rewriting in place instead.";
    }

    setBusy(true, "rewriting…");
    const r = await runHumanize({
      text: working,
      lang: from === to ? from : to,
      provider,
      target: Number($("target").value) || 30,
      maxCalls: rulesOnly ? 0 : Number($("maxcalls").value) || 5,
      glossary: glossary(),
      aggressive: $("aggressive").value === "on",
      signal: ctl.signal,
      onProgress: ({ passes }) => renderPasses($("passes"), passes),
    });

    state.runId = "run-" + Date.now().toString(36);
    state.input = text;
    state.output = r.output;
    state.lang = r.lang;

    $("result").classList.remove("hidden");
    renderScores($("result-scores"), r);
    $("result-note").textContent = r.note;
    $("output").value = r.output;
    $("output-meta").textContent = "· " + r.words + " words · " + nameOf(r.lang) +
      (r.winner === null ? " · no pass was accepted" : " · winner: pass " + r.winner);

    const warn = $("result-warn");
    warn.innerHTML = "";
    if (r.before.report.n_words < 120) {
      warn.appendChild(el("div", "warnbox",
        "Under 120 words. These signals are densities per 1000 words, so a single phrase swings the " +
        "result. The number above is not worth much on a text this short."));
    }
    if (!r.calibrated) {
      warn.appendChild(el("div", "warnbox",
        "The bands behind this number were measured on Hindi and extrapolated to " + nameOf(r.lang) +
        ". The loop optimised literal defect count, which stays reliable; the percentage is a read-out."));
    }
    if (!r.reachedTarget) {
      warn.appendChild(el("div", "warnbox",
        "The target was not reached. Everything the guards would allow has been applied — pushing " +
        "further would mean accepting a pass that failed one of them."));
    }

    renderPasses($("passes"), r.passes);
    renderParams($("params").querySelector("tbody"), r.before.report, r.after.report);
    renderObservations(r.after.report);
    renderRefusals($("refusals"), r.ruleRefusals);
    if (r.ruleSuggestions && r.ruleSuggestions.length) {
      const d = el("div");
      d.appendChild(el("b", null, "Flagged but not changed for you"));
      for (const s of r.ruleSuggestions) d.appendChild(el("p", "note", s.detail));
      $("refusals").prepend(d);
    }

    setBusy(false, "done");
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setBusy(false, "");
    const warn = $("result-warn");
    $("result").classList.remove("hidden");
    warn.innerHTML = "";
    warn.appendChild(el("div", "warnbox hard", e.message || String(e)));
  } finally {
    state.busy = null;
  }
}

$("run").addEventListener("click", () => doRun());
$("run-rules").addEventListener("click", () => doRun({ rulesOnly: true }));
$("cancel").addEventListener("click", () => { if (state.busy) state.busy.abort(); setBusy(false, "stopped"); });

$("copy-out").addEventListener("click", () => navigator.clipboard.writeText($("output").value));
$("copy-in").addEventListener("click", () => navigator.clipboard.writeText(state.input));
$("send-verify").addEventListener("click", () => {
  document.getElementById("tab-verify").click();
  $("v-run-note").textContent = "Recording against run " + state.runId + " (" + nameOf(state.lang) + ").";
});

/* ─────────────────────────── score-only tab ─────────────────────────── */

$("run-score").addEventListener("click", () => {
  const text = $("score-input").value.trim();
  if (!text) return;
  const lang = $("score-lang").value;
  const r = D.scoreLocal(text, lang);
  const rep = r.report;

  $("score-result").classList.remove("hidden");
  const node = $("score-scores");
  node.innerHTML = "";
  const s = el("div", "score " + bandOf(rep.ai_likeness));
  s.appendChild(el("b", null, rep.ai_likeness + "%"));
  s.appendChild(el("span", null, "AI-likeness (proxy)"));
  node.appendChild(s);
  const w = el("div", "score");
  w.appendChild(el("b", null, String(rep.n_words)));
  w.appendChild(el("span", null, "words"));
  node.appendChild(w);

  // No verdict label off the two calibrated languages: "reads as human-written"
  // asserts a confidence the instrument does not have there.
  $("score-verdict").textContent = r.calibrated
    ? rep.verdict.label + " — " + rep.verdict.detail
    : "No verdict is shown for " + nameOf(rep.lang) + ". The bands were measured on Hindi; the " +
      "literal defects below are still reliable, the number is not.";
  $("score-method").textContent = r.note;

  renderParams($("score-params").querySelector("tbody"), rep, rep);

  const flags = $("score-flags");
  flags.innerHTML = "";
  if (!(rep.flags || []).length) flags.appendChild(el("p", "tiny", "None of the literal defect patterns matched."));
  for (const f of rep.flags || []) {
    const d = el("div", "pass " + (f.severity === "error" ? "no" : ""));
    d.appendChild(el("b", null, f.kind + (f.phrase ? ' — "' + f.phrase + '"' : "")));
    d.appendChild(el("p", null, f.detail));
    flags.appendChild(d);
  }
});

/* ─────────────────────────── verify tab ─────────────────────────── */

function renderLog() {
  const tb = $("v-log").querySelector("tbody");
  tb.innerHTML = "";
  const rows = D.readLog();
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "tiny", "Nothing recorded yet. A row needs both a before and an after before its delta means anything.");
    td.colSpan = 6;
    tr.appendChild(td); tb.appendChild(tr);
    return;
  }
  for (const r of rows.slice().reverse()) {
    const tr = el("tr");
    tr.appendChild(el("td", null, r.runId));
    tr.appendChild(el("td", null, r.detector));
    tr.appendChild(el("td", null, r.lang || "—"));
    tr.appendChild(el("td", "num", r.before ?? "—"));
    tr.appendChild(el("td", "num", r.after ?? "—"));
    const d = el("td", "num", r.delta === undefined ? "incomplete" : (r.delta > 0 ? "+" : "") + r.delta);
    if (r.delta !== undefined) d.style.color = r.delta < 0 ? "var(--good)" : "var(--bad)";
    tr.appendChild(d);
    tb.appendChild(tr);
  }
}

$("v-add").addEventListener("click", () => {
  try {
    D.addLog({
      runId: state.runId || "manual",
      detector: $("v-detector").value.trim(),
      side: $("v-side").value,
      score: $("v-score").value,
      lang: state.lang,
    });
    $("v-score").value = "";
    renderLog();
  } catch (e) {
    $("v-run-note").textContent = e.message;
  }
});

$("v-clear").addEventListener("click", () => { D.clearLog(); renderLog(); });
$("v-csv").addEventListener("click", () => {
  const blob = new Blob([D.logCsv()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "humanizer-detector-log.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

function loadDetectorConfig() {
  const c = D.getConfig();
  $("d-name").value = c.name; $("d-url").value = c.url; $("d-field").value = c.field;
  $("d-keyheader").value = c.keyHeader; $("d-key").value = c.key;
  $("d-path").value = c.responsePath; $("d-scale").value = c.scale;
  $("d-status").textContent = D.configured() ? " configured" : " not configured — it will refuse to run";
}

$("d-save").addEventListener("click", () => {
  D.setConfig({
    name: $("d-name").value, url: $("d-url").value, field: $("d-field").value,
    keyHeader: $("d-keyheader").value, key: $("d-key").value,
    responsePath: $("d-path").value, scale: $("d-scale").value,
  });
  loadDetectorConfig();
});

/* ─────────────────────────── boot ─────────────────────────── */

/* Optional local credentials. `keys.local.js` sits next to index.html, is
 * gitignored, and exists only on a machine where someone put it there — so
 * this import failing is the NORMAL case on the hosted copy, and the 404 in
 * the console is expected rather than a fault.
 *
 * It seeds localStorage, which is where keys live either way. Nothing about
 * the storage model changes; this just saves retyping on a fresh profile.
 * Note that browser storage is per-origin: the file only affects the origin it
 * is served from, so localhost and the Pages URL keep separate keys. */
try {
  const local = await import("../keys.local.js");
  localKeyFile = { found: true, applied: local.applyLocalKeys() };
} catch {
  /* No local key file. Expected on any hosted copy. */
}

/* After the file import, so an explicit setup link always wins over it. */
const fromLink = applyKeysFromHash();
if (fromLink) localKeyFile = { found: true, applied: fromLink, viaLink: true };

langOptions($("from"), { selected: "en" });
langOptions($("to"), { selected: "hi" });
langOptions($("score-lang"), { selected: "hi" });
$("from").addEventListener("change", pairNote);
$("to").addEventListener("change", pairNote);
pairNote();

fillProviders();
renderLog();
loadDetectorConfig();

const dl = $("known-detectors");
for (const d of D.KNOWN_DETECTORS) {
  const o = document.createElement("option");
  o.value = d.name;
  o.label = d.note;
  dl.appendChild(o);
}

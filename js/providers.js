/* providers.js — every model backend, behind one interface.
 *
 * "All the model backends" is a REGISTRY problem, not an adapter problem.
 * There are only three code paths here:
 *
 *   gemini             ?key= in the query string, no auth header
 *   openai-compatible  POST {base}/chat/completions, Bearer auth
 *                      -> OpenAI, Groq, OpenRouter, Together, DeepSeek,
 *                         Mistral, Ollama, LM Studio, and anything else that
 *                         copied that request shape
 *   anthropic          x-api-key + the direct-browser-access header
 *
 * Adding a provider is a five-field registry row, not a new adapter.
 *
 * TWO THINGS THAT WILL BITE IF CHANGED CARELESSLY
 *
 * 1. Anthropic REQUIRES `anthropic-dangerous-direct-browser-access: true`.
 *    Without it the CORS preflight fails outright — the request never leaves
 *    the browser, and what you see is an opaque "Failed to fetch".
 *
 * 2. Anthropic's current models REJECT `temperature` with a 400. Sampling
 *    parameters were removed on claude-opus-5 / claude-sonnet-5. So the
 *    retry-variation strategy is per-provider and lives in this file: Gemini
 *    and the OpenAI-shaped endpoints raise temperature on each retry;
 *    Anthropic varies the prompt instead and sends no sampling parameters at
 *    all. loop.js only ever says "attempt k" — it does not know the difference.
 *
 * KEYS. Stored per provider at hz.key.<id> in localStorage, never anywhere
 * else, never defaulted. The `hz.` prefix matters: if this tool and bhasha-seo
 * are both served from the same github.io origin they share one localStorage,
 * and bhasha-seo's `bhasha.geminiKey` must not be read or clobbered.
 */

const LS = typeof localStorage !== "undefined" ? localStorage : {
  _m: {}, getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; },
};

export const keyOf = (id) => "hz.key." + id;
export const modelOf = (id) => "hz.model." + id;

export const getKey = (id) => (LS.getItem(keyOf(id)) || "").trim();
export const hasKey = (id) => getKey(id).length > 0;
export const setKey = (id, v) => { const s = (v || "").trim(); s ? LS.setItem(keyOf(id), s) : LS.removeItem(keyOf(id)); };

export const getModel = (id) => (LS.getItem(modelOf(id)) || "").trim();
export const setModel = (id, v) => { const s = (v || "").trim(); s ? LS.setItem(modelOf(id), s) : LS.removeItem(modelOf(id)); };

/* Decode a `#keys=<base64url>` setup fragment.
 *
 * Lives here rather than in app.js for two reasons: this module owns key
 * storage, and it is DOM-free, so the regression suite can exercise the
 * decoder offline. app.js owns the confirmation prompt and the write.
 *
 * Returns null on anything malformed — a setup link that half-applies would be
 * worse than one that does nothing. */
export function decodeKeyPayload(hash) {
  const m = /(?:^|[#&])keys=([A-Za-z0-9_-]+=*)/.exec(hash || "");
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

/* ───────────────────────────── the registry ───────────────────────────── */

/* `model` is a DEFAULT, not a pin. Every row's model is editable in Settings,
 * because provider model ids churn faster than this file will be updated and a
 * stale default should be a thirty-second fix, not a bug report. */
export const REGISTRY = [
  {
    id: "rules", label: "Rule-based (no key, offline)", kind: "none", needsKey: false,
    note: "Deterministic edits only. Always available, costs nothing, never calls out. Lower ceiling than a model.",
  },
  {
    id: "gemini", label: "Google Gemini", kind: "gemini", needsKey: true,
    keyHelp: "aistudio.google.com/apikey — free tier",
    models: ["gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-flash-lite-latest"],
    note: "Free tier. Verified to answer browser calls directly.",
  },
  {
    id: "anthropic", label: "Anthropic (Claude)", kind: "anthropic", needsKey: true,
    keyHelp: "console.anthropic.com — paid",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    note: "Sends the direct-browser-access header. No temperature — current Claude models reject it.",
  },
  {
    id: "openai", label: "OpenAI", kind: "openai", needsKey: true,
    base: "https://api.openai.com/v1", models: ["gpt-4o-mini", "gpt-4o"],
  },
  {
    id: "groq", label: "Groq (fast, free tier)", kind: "openai", needsKey: true,
    // Verified against a live key 2026-08-31. Groq's lineup churns hard and the
    // old llama-3.3 slugs now 404; these are what /models actually returns.
    base: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b", "groq/compound"],
  },
  {
    id: "openrouter", label: "OpenRouter (many models)", kind: "openai", needsKey: true,
    base: "https://openrouter.ai/api/v1", models: ["meta-llama/llama-3.3-70b-instruct", "google/gemini-flash-1.5"],
  },
  {
    id: "together", label: "Together", kind: "openai", needsKey: true,
    base: "https://api.together.xyz/v1", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  {
    id: "deepseek", label: "DeepSeek", kind: "openai", needsKey: true,
    base: "https://api.deepseek.com/v1", models: ["deepseek-chat"],
  },
  {
    id: "mistral", label: "Mistral", kind: "openai", needsKey: true,
    base: "https://api.mistral.ai/v1", models: ["mistral-small-latest", "mistral-large-latest"],
  },
  {
    id: "ollama", label: "Ollama (localhost)", kind: "openai", needsKey: false, local: true,
    base: "http://localhost:11434/v1", models: ["llama3.2", "qwen2.5"],
    note: "Needs OLLAMA_ORIGINS set to this page's origin. Most reliable when you run this tool " +
      "from the local python http.server rather than a hosted URL; Safari blocks https->http entirely.",
  },
  {
    id: "lmstudio", label: "LM Studio (localhost)", kind: "openai", needsKey: false, local: true,
    base: "http://localhost:1234/v1", models: ["local-model"],
    note: "Enable the local server and its CORS option in LM Studio.",
  },
  {
    id: "mymemory", label: "MyMemory (translate only, no key)", kind: "mymemory", needsKey: false,
    translateOnly: true,
    note: "Keyless machine translation, and honestly poor — it is a fallback so the Translate tab " +
      "works before you enter any credential, not a recommendation.",
  },
];

export const BY_ID = Object.fromEntries(REGISTRY.map((p) => [p.id, p]));

export function defaultModel(id) {
  const p = BY_ID[id];
  return getModel(id) || (p && p.models ? p.models[0] : "");
}

/* Is this provider usable right now? Drives the dropdown's disabled state.
 * An unconfigured provider is shown DISABLED, never hidden — a hidden
 * provider looks to the user like it does not exist. */
export function status(id) {
  const p = BY_ID[id];
  if (!p) return { ok: false, why: "unknown" };
  if (!p.needsKey) return { ok: true, why: p.local ? "local — must be running" : "no key needed" };
  return hasKey(id) ? { ok: true, why: "ready" } : { ok: false, why: "needs key" };
}

/* ─────────────────────────── error classification ─────────────────────────── */

/* Worth getting right. A CORS rejection reaches JS as an opaque
 * `TypeError: Failed to fetch` — indistinguishable from being offline and
 * nothing like a bad key. Users will blame the key and re-paste it forever. */
export function classify(err, res) {
  const st = res && res.status;
  if (st === 401 || st === 403) return "rejected";
  if (st === 429 || st === 503 || st === 529) return "quota";
  if (st) return "http";
  if (err instanceof TypeError) return "blocked";
  return "unknown";
}

export const FAILURE_TEXT = {
  rejected: "That key was rejected by the provider. Check it in Settings.",
  quota: "Rate-limited or out of quota. Wait and retry, or switch provider.",
  http: "The provider returned an error. See the detail below.",
  blocked: "The browser refused the response. Either you are offline, or this endpoint does not " +
    "allow direct browser calls. This is NOT a key problem — check the browser console for the CORS message.",
  unknown: "The call failed for an unrecognised reason.",
};

class ProviderError extends Error {
  constructor(cls, detail) { super(detail); this.failureClass = cls; this.detail = detail; }
}

async function readErr(res) {
  try { return (await res.text()).slice(0, 400); } catch { return "(no body)"; }
}

/* Strip code fences and slice to the outermost JSON. Every provider fences
 * JSON sooner or later regardless of what the prompt asked for. */
export function parseJson(raw) {
  if (!raw) return null;
  const s = stripFence(raw);
  for (const candidate of [s, sliceBraces(s)]) {
    if (!candidate) continue;
    for (const attempt of [candidate, repairNewlines(candidate)]) {
      try { return JSON.parse(attempt); } catch { /* keep trying */ }
    }
  }
  return null;
}

const stripFence = (raw) =>
  String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

function sliceBraces(s) {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return (a !== -1 && b > a) ? s.slice(a, b + 1) : null;
}

/* THE BUG THIS EXISTS FOR.
 *
 * A raw newline inside a JSON string literal is illegal, and models emit them
 * constantly when the value is a multi-paragraph article:
 *
 *     {"text": "First paragraph.
 *
 *     Second paragraph.", "changes": [...]}
 *
 * JSON.parse rejects that, parseJson returned null, and the caller's
 * `|| raw` fallback then shipped the ENTIRE fenced blob — braces, the
 * `changes` array and all — as the translation. It reached a real detector
 * before anyone noticed, because a wall of JSON still scores as text.
 *
 * So: walk the string, track whether we are inside a literal, and escape the
 * control characters that should have been escaped. */
function repairNewlines(s) {
  let out = "", inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

/* Pull the rewritten text out of a model reply, and REFUSE rather than guess.
 *
 * The old contract was `parseJson(raw)?.text || raw`, and that `|| raw` is
 * what leaked JSON into a deliverable. A reply that is clearly JSON but cannot
 * be read is a failure, not a translation — say so and let the caller retry.
 *
 * A model that ignores the JSON instruction and simply writes the article is
 * fine and common, so plain prose is still accepted. */
export function extractText(raw) {
  const s = stripFence(raw || "");
  if (!s.trim()) return { ok: false, why: "The model returned nothing." };

  const parsed = parseJson(s);
  if (parsed && typeof parsed.text === "string" && parsed.text.trim()) {
    return { ok: true, text: parsed.text, changes: parsed.changes || [] };
  }

  const looksJson = /^[{[]/.test(s) || /"\s*(?:text|changes)\s*"\s*:/.test(s);

  if (looksJson) {
    // Last resort: lift the "text" value by hand, honouring backslash escapes.
    const m = /"text"\s*:\s*"/.exec(s);
    if (m) {
      let i = m.index + m[0].length, buf = "", esc = false;
      for (; i < s.length; i += 1) {
        const ch = s[i];
        if (esc) { buf += ch === "n" ? "\n" : ch === "t" ? "\t" : ch; esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') break;
        buf += ch;
      }
      if (buf.trim()) return { ok: true, text: buf, changes: [], repaired: true };
    }
    return {
      ok: false,
      why: "The model replied with JSON this tool could not read, and refusing is the only safe " +
        "option — passing the raw reply through would put braces and the change-log into your text.",
    };
  }

  return { ok: true, text: s, changes: [], plain: true };
}

/* A cheap structural check for the same failure surviving by another route.
 * Nothing legitimate this tool produces opens with a brace or carries a
 * "changes": key. */
export function looksLikeJsonEnvelope(text) {
  const t = (text || "").trim();
  return /^[{[]/.test(t) || /"\s*changes\s*"\s*:\s*\[/.test(t) || /^```/.test(t);
}

/* Retry variation. Gemini and the OpenAI-shaped endpoints take a rising
 * temperature; Anthropic takes none at all (400) and varies by prompt. */
const tempFor = (attempt) => Math.min(1.0, 0.7 + 0.1 * (attempt || 0));

/* ──────────────────────────── the three paths ──────────────────────────── */

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

async function callGemini({ prompt, attempt, maxTokens, signal }) {
  const key = getKey("gemini");
  if (!key) throw new ProviderError("rejected", "No Gemini key saved.");

  // Try the configured model, then fall down the preferred list. Concrete ids
  // before the -latest aliases: aliases are what every untuned client hits and
  // are the first to return 503.
  const wanted = defaultModel("gemini");
  const chain = [wanted, ...BY_ID.gemini.models.filter((m) => m !== wanted)];

  let last = null;
  for (const model of chain) {
    let res;
    try {
      res = await fetch(GEMINI_API + "/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: tempFor(attempt), maxOutputTokens: maxTokens || 8192 },
        }),
      });
    } catch (e) {
      throw new ProviderError(classify(e), e.message);
    }
    if (res.ok) {
      const j = await res.json();
      const cand = j.candidates && j.candidates[0];
      if (cand && cand.finishReason === "SAFETY") {
        throw new ProviderError("http", "Gemini blocked this text under its safety filter.");
      }
      const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
      if (text.trim()) return text;
      last = new ProviderError("http", "Gemini returned an empty response (" + model + ").");
      continue;
    }
    const cls = classify(null, res);
    const body = await readErr(res);
    // A rejected key will be rejected by every model; do not walk the chain.
    if (cls === "rejected") throw new ProviderError(cls, body);
    last = new ProviderError(cls, model + ": " + body);
  }
  throw last || new ProviderError("unknown", "Every Gemini model failed.");
}

async function callOpenAICompat(p, { prompt, attempt, maxTokens, signal }) {
  const key = getKey(p.id);
  if (p.needsKey && !key) throw new ProviderError("rejected", "No key saved for " + p.label + ".");

  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;

  let res;
  try {
    res = await fetch(p.base + "/chat/completions", {
      method: "POST", signal, headers,
      body: JSON.stringify({
        model: defaultModel(p.id),
        messages: [{ role: "user", content: prompt }],
        temperature: tempFor(attempt),
        max_tokens: maxTokens || 8192,
      }),
    });
  } catch (e) {
    // The most likely cause for a localhost row is "the server isn't running".
    throw new ProviderError(classify(e), p.local
      ? p.label + " did not answer. Is it running, and is CORS enabled for this page's origin?"
      : e.message);
  }
  if (!res.ok) throw new ProviderError(classify(null, res), await readErr(res));
  const j = await res.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text || !text.trim()) throw new ProviderError("http", p.label + " returned an empty response.");
  return text;
}

async function callAnthropic({ prompt, maxTokens, signal }) {
  const key = getKey("anthropic");
  if (!key) throw new ProviderError("rejected", "No Anthropic key saved.");

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // Load-bearing. Without this the CORS preflight fails and the request
        // never leaves the browser.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      // No temperature / top_p / top_k: current Claude models reject sampling
      // parameters with a 400. Retry variation is handled by the prompt.
      body: JSON.stringify({
        model: defaultModel("anthropic"),
        max_tokens: maxTokens || 8192,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    throw new ProviderError(classify(e), e.message);
  }
  if (!res.ok) throw new ProviderError(classify(null, res), await readErr(res));
  const j = await res.json();
  if (j.stop_reason === "refusal") {
    throw new ProviderError("http", "Claude declined this request" +
      (j.stop_details && j.stop_details.category ? " (" + j.stop_details.category + ")" : "") + ".");
  }
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.trim()) throw new ProviderError("http", "Anthropic returned an empty response.");
  return text;
}

/* MyMemory is a translation endpoint, not a chat model, so it cannot serve
 * `generate` at all. It is reached only through translateVia below. */
async function callMyMemory(text, from, to, signal) {
  // Chunk on sentence boundaries under the documented query limit.
  const chunks = [];
  let cur = "";
  for (const part of String(text).split(/(?<=[.!?।॥\n])\s+/)) {
    if (new Blob([cur + " " + part]).size > 450 && cur) { chunks.push(cur); cur = part; }
    else cur = cur ? cur + " " + part : part;
  }
  if (cur) chunks.push(cur);

  const out = [];
  for (const c of chunks) {
    const url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(c) +
      "&langpair=" + encodeURIComponent(from) + "|" + encodeURIComponent(to);
    let res;
    try { res = await fetch(url, { signal }); }
    catch (e) { throw new ProviderError(classify(e), e.message); }
    if (!res.ok) throw new ProviderError(classify(null, res), await readErr(res));
    const j = await res.json();
    const t = j.responseData && j.responseData.translatedText;
    if (!t) throw new ProviderError("http", "MyMemory returned no translation.");
    out.push(t);
  }
  return out.join(" ");
}

/* ─────────────────────────── public interface ─────────────────────────── */

/* One shape for every backend. loop.js knows nothing beyond this. */
export async function generate(providerId, { prompt, attempt = 0, maxTokens, signal } = {}) {
  const p = BY_ID[providerId];
  if (!p) throw new ProviderError("unknown", "Unknown provider: " + providerId);
  if (p.kind === "none") throw new ProviderError("unknown", "The rule-based backend does not call a model.");
  if (p.kind === "mymemory") throw new ProviderError("unknown", "MyMemory can translate but cannot rewrite.");
  if (p.kind === "gemini") return callGemini({ prompt, attempt, maxTokens, signal });
  if (p.kind === "anthropic") return callAnthropic({ prompt, attempt, maxTokens, signal });
  return callOpenAICompat(p, { prompt, attempt, maxTokens, signal });
}

export async function translateVia(providerId, { text, from, to, signal } = {}) {
  if (providerId === "mymemory") return callMyMemory(text, from, to, signal);
  throw new ProviderError("unknown", "translateVia is only for the keyless MyMemory path.");
}

/* Smallest call that proves the credential works. */
export async function test(providerId, signal) {
  const t0 = Date.now();
  const p = BY_ID[providerId];
  try {
    if (!p) throw new ProviderError("unknown", "Unknown provider.");
    if (p.kind === "none") return { ok: true, ms: 0, model: "-", reply: "always available" };
    if (p.kind === "mymemory") {
      const r = await callMyMemory("hello", "en", "hi", signal);
      return { ok: true, ms: Date.now() - t0, model: "mymemory", reply: r.slice(0, 40) };
    }
    const reply = await generate(providerId, { prompt: "Reply with exactly: ok", maxTokens: 16, signal });
    return { ok: true, ms: Date.now() - t0, model: defaultModel(providerId), reply: reply.trim().slice(0, 40) };
  } catch (e) {
    return {
      ok: false, ms: Date.now() - t0, model: defaultModel(providerId),
      failureClass: e.failureClass || "unknown",
      detail: (FAILURE_TEXT[e.failureClass] || FAILURE_TEXT.unknown) + " " + (e.detail || e.message || ""),
    };
  }
}

/* Ollama and LM Studio are probed rather than assumed — a localhost row that
 * claims to be ready when nothing is listening is worse than one that says
 * "not detected". */
export async function probeLocal(providerId) {
  const p = BY_ID[providerId];
  if (!p || !p.local) return { up: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(p.base + "/models", { signal: ctl.signal });
    return { up: res.ok };
  } catch { return { up: false }; }
  finally { clearTimeout(timer); }
}

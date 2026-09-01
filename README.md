# Humanizer

Translate between any pair of 23 languages, then rewrite the output until it stops reading as
machine-produced. Static page, no backend, no build step, no dependencies.

**Live:** <https://sagarchauhan7792-bot.github.io/humanizer/>
**Regression suite:** <https://sagarchauhan7792-bot.github.io/humanizer/test.html>

Bring your own API key — it is stored in your browser's localStorage and nowhere else. No key ships
with the tool, none is defaulted, and the offline pass and all scoring work with no key at all.

```bash
start.bat
```

Then open <http://localhost:8778>. (ES modules will not load over `file://`, so it needs the
server.) It also deploys as-is to GitHub Pages — `.nojekyll` is already there.

```bash
node test.mjs
```

runs the regression suite. `test.html` runs the same assertions in the browser.

---

## What it actually does

Four things, in this order:

0. **Imports a blog post from its URL** — or you paste the text. Extracts the article, detects the
   language, and says which route fetched it (see below).
1. **Translates** — any pair among English, the 22 Eighth Schedule languages, and Hinglish.
2. **Runs a deterministic offline pass** — no key, no network. On raw machine translation this is
   the single biggest free win in the tool (measured below).
3. **Runs a score-driven rewrite loop** — a model edits the text, and each candidate must clear nine
   gates before it is allowed to replace what came before.

## Importing from a URL

Paste a link, press **Load article**. Measured against a real post
(`hiims.in/blog/fungal-eye-keratitis-causes`): 1334 words extracted, title captured, language
detected, in about a second.

A browser cannot fetch an arbitrary website directly — almost no site sends
`Access-Control-Allow-Origin`, so the request is blocked before it starts. Getting round that needs a
proxy, and **a proxy sees the URL you asked for**. So the order is deliberate:

1. **Direct** read, tried every time. When it works, no third party is involved at all.
2. `r.jina.ai` only if the site blocked the direct read.
3. `allorigins.win` as a last resort.

**Which route succeeded is printed next to the result, every time.** Green means direct and private;
amber means a proxy saw the URL. It never silently proxies.

Two things to expect. **Red console errors on a blocked direct read are normal** — the browser emits
"blocked by CORS policy" itself, before any script sees it, and no page can suppress that; seeing it
means the fallback is working. And **fetched content is data, not instructions**: it lands in the
textarea with `.value`, never `innerHTML`, nothing in it is executed, and if you then run a rewrite it
goes to your model as text to edit. Read what you loaded before spending a call on it.

The page's own `lang` attribute is treated as a hint, not an answer — plenty of Hindi blogs declare
`lang="en"`. The script tally wins, and a disagreement is shown rather than resolved silently. Sites
behind Cloudflare, a login or a paywall generally cannot be read this way, and the error names every
route it tried.

## The rule the whole tool rests on

> **The score chooses the direction and picks the winner. It is never allowed to grant admission.**

Every candidate clears gates 1–8 before its score is computed, and evaluation stops at the first
failure. A high score cannot rescue a candidate that failed a gate, because the score is never
consulted for a failed one.

That constraint is the reason this tool exists as a separate thing. `bhasha-seo`'s humanizer refuses
to chase the score at all (`js/humanize.js:1-28`, "Goodhart's law with an API bill"), and it was
right to given what it had. `aeo-translator` re-armed the same trigger safely (`run.py:189-325`) by
putting structural guards in front of it. This is that idea, in the browser.

| # | Gate | Rejects |
|---|------|---------|
| 1 | Placeholders & figures | A dropped protected value, or a figure the model invented |
| 2 | Protected spans | A URL, dosage, price or percentage that changed |
| 3 | Meaning | A hedge that was dropped — "may reduce" quietly becoming "reduces" |
| 4 | Length | Beyond 75–125% of the original **and** ±15% per pass |
| 5 | Locked terms | Anything you listed that vanished |
| 6 | Script | Indic text drifting back toward English |
| 7 | Metric gaming | Commas deleted without sentences split; stub paragraphs inserted |
| 8 | Defect trading | A pass that fixes two defects by creating a third |
| 9 | Score | Only now: no meaningful gain, no acceptance |

**Gate 1 is the important one.** Every number, price, dosage, URL, email and phone is replaced by an
opaque token *before the model sees the text*. So "did it invent a statistic?" stops being a
judgement call and becomes a string comparison: a digit run in the output that is not in the masked
input can only have been invented. That is the exact failure `aeo-translator/test_rewrite_loop.py`
case 5 exists for, and case 1 of this repo's suite is its port.

**Gate 4 fixes a live hole.** `bhasha-seo/js/humanize.js:219` checks each candidate against the
*previous pass*, and the length band is a ratio — three chained passes at 0.88× each land at 0.68× of
the original and never trip it. Every ratio gate here is evaluated against both the original and the
predecessor.

A rejection **discards and retries**; it does not end the run. The output is the best-scoring
accepted pass, and the free offline pass is always on that leaderboard — so a run where every model
attempt is rejected still returns a real improvement rather than your raw input.

## What the loop is *not* allowed to chase

Chasing a score invites edits that move the number without improving the text. Two signals are
measured and reported but never optimised:

- **Passive voice** (English, weight .15). `CALIBRATION.md:137-151` records that its bands came from
  long articles, that short text scores 0 "regardless of who wrote the text", and that it was
  deliberately not retuned. Chasing it means inserting passives to harvest points from a measurement
  that does not apply.
- **Colon-led lists** (English, weight .25) — for the offline pass only. The detector matches a
  literal colon; swapping `:` for an em dash kills the match without changing one word, and em-dash
  density was measured and dropped from the score, so nothing offsets it. A model may rewrite the
  list into prose; a regex may not.

The English objective is therefore renormalised over the remaining three (.353 / .353 / .294). The
four Indic signals keep the equal .25 weights they were calibrated with.

## The offline pass: measured, not estimated

Run on 100 words of MT-shaped Hindi with 14 detokenisation artefacts, no key and no network:

```
AI-likeness (proxy)        100%  →  75%
sp_punct_1k parameter         0  →  100
protected spans (500 mg, 30%, URL, email)   all intact
```

That 25-point drop is one regex. What it does **not** touch is equally the point:

| Signal | Offline pass | Why |
|---|---|---|
| `sp_punct_1k` | **Solved** | Pure mechanics — cannot change meaning, so there is no way to game it |
| `tell_1k` (EN) | **Mostly** | Sentence-initial discourse markers delete cleanly; adjectival tells are flagged, never auto-deleted |
| `prep_calque_1k` | 1 of 3 | `के माध्यम से → से` is idiomatic. `के द्वारा → ने` changes case marking and interacts with ergativity. `के रूप में` has no mechanical replacement. Off by default |
| `comma_1k` | **Refused** | The real fix is splitting comma splices, and a regex cannot verify the second clause has a finite verb |
| `rel_1k` | **Refused** | Needs a parse. Deleting `जो` moves the number and yields ungrammatical Hindi |
| `colon_lists_1k`, `para_cv` | **Refused** | Trivially gamed. The pass reports them and leaves them alone |

## Two bugs found by running it against real detectors

Both were found the same way — by pasting real output into QuillBot and GPTZero — and both are worth
recording rather than quietly patching.

### 1. A JSON envelope shipped as the deliverable

A raw newline inside a JSON string literal is illegal, and models emit them constantly when the value
is a multi-paragraph article. `JSON.parse` rejected it, `parseJson` returned `null`, and the caller's
`|| raw` fallback made the **entire fenced blob** — braces, the `changes` array and all — the
translation. 1,556 words of it reached GPTZero before anyone noticed, because a wall of JSON still
scores as text.

Fixed three ways: the parser now repairs unescaped control characters inside string literals;
`extractText` **refuses** rather than falling back to the raw reply when it looks like JSON it cannot
read; and the translate path — which previously had **no checks at all** — now retries, rejects
anything shaped like an envelope, and verifies protected-value counts the way the rewrite loop does.
Test case 12.

### 2. The English detector is largely a stock-phrase detector

A real 1,392-word document scored **8.8% — "reads as human-written"** here. QuillBot called it **96%
AI-generated**; GPTZero **74%**. The tool was wrong, not the detectors.

The cause is structural. `tell_1k` and `colon_lists_1k` are **55% of the English weight between them
and are keyword lookups** against "moreover", "delve into", "tapestry". Current model prose does not
use that 2023 vocabulary, so both returned a perfect 100 *for its absence* — which is not evidence a
person wrote anything. Only `passive_ratio` fired, and that is the one signal deliberately excluded
from the objective, so the loop had nothing to act on and ran **zero passes**.

Measured across every labelled English fixture available:

```
              sent_cv  nominal_1k  contraction_1k  person_1k  lead_frac  ai_likeness
a1     ai       0.331        45.6             0         9.1      0.136        39.7
a2     ai       0.270        41.2             0        17.4      0.069        15.0
a3     ai       0.360        49.9             0         0.0      0.087        44.5
a4     HUMAN    0.404        12.0           4.8        64.7      0.045        39.8
a5     ai       0.378        55.9             0        23.7      0.043        54.4
liver  ai       0.266        85.4             0         0.0      0.357        13.1   (QB 96%, GPTZero 74%)
```

**The shipped composite ranks the human sample (39.8) as more AI-like than the AI mean (33.3)** — the
same failure shape as the AUC 0.21 first version of bhasha-seo's detector. Nominalisation density,
contractions and person separate cleanly; `sent_cv` was measured at 0.08 separation during the
original calibration and dropped, which now looks wrong.

**Those signals ship unscored, deliberately.** `n_human = 1`. One sample cannot set a band, and
inventing calibrated-looking numbers is precisely the mistake `CALIBRATION.md` was written to prevent.
They are displayed, fed to the rewriter as instructions, and counted as defects the loop may act on —
with **zero weight in any composite**. `js/en-signals.js` carries the full record and the promotion
criteria. Test case 13 pins both halves: the flags must fire, and they must stay out of the number.

The English verdict also no longer says "reads as human-written" when the score came mostly from
absent keywords. It now says what it actually knows.

> **To fix this properly I need ~8 genuinely human-written English documents** of comparable length
> and register — your own agency's copy, or client copy you know a person wrote. With those the
> harness re-runs and these become real bands. Until then they stay observations.

## Two calibrated languages out of 23, and the tool behaves differently

The bands come from real Hindi — native BBC Hindi, human-translated Wikipedia, raw MT — separating at
AUC 1.00 / Cohen's d 3.2. English has its own separately measured bands. **Nothing else is
calibrated.**

For the other 21 languages the word lists are genuinely per-language and the literal matches stay
reliable ("a text either contains `के रूप में` or it does not"), but the numeric bands are Hindi's
extrapolated. So:

| Language | Loop optimises | Verdict label |
|---|---|---|
| `hi`, `en` | the score | shown |
| the other 21 + Hinglish | **literal defect count** | **withheld** |

"Reads as human-written" asserts a confidence the instrument does not have off Hindi and English, so
it is not printed there.

## Verifying the actual claim

The tool's claim is that it lowers an AI-detector score. That is only checkable with a detector in
the loop, and:

- No commercial detector (GPTZero, Originality, Turnitin, Winston, QuillBot) is validated on any
  Indian language.
- None offers a usable free API; several refuse browser calls outright.

So there are two honest paths, both in the **Verify** tab:

- **A generic HTTP adapter** (URL, key header, request field, dotted response path, scale). It runs at
  most twice per rewrite — once on the input, once on the output — and *never inside the loop*. Left
  unconfigured it refuses to run rather than guess.
- **A manual before/after log.** Copy each text into the detector of your choice and type both
  numbers in. A row stays incomplete until both halves exist, because a lone "after" number is
  evidence of nothing. Exports to CSV.

**And the thing that has to be said plainly:** lowering this score does not guarantee GPTZero,
Turnitin or Originality will call your text human. They are closed, they disagree with each other,
and none understands these languages. What this measurably does is remove the specific artefacts,
measured against real text, that make copy read as machine-produced.

## Providers

All selectable; unconfigured ones are shown **disabled, never hidden**. Keys live in this browser's
localStorage under `hz.key.<id>` and nowhere else — no key ships with the tool and none is defaulted.
Model names are editable defaults, not pins.

| Path | Providers |
|---|---|
| `gemini` | Google Gemini (free tier; verified to answer browser calls) |
| `anthropic` | Claude — needs `anthropic-dangerous-direct-browser-access`, and sends **no** `temperature`, which current Claude models reject with a 400 |
| `openai-compatible` | OpenAI, Groq, OpenRouter, Together, DeepSeek, Mistral, Ollama, LM Studio |
| none | Rule-based (offline, always available) and MyMemory (keyless translation, honestly poor) |

Retry variation is per-provider and lives in `providers.js`: Gemini and the OpenAI-shaped endpoints
raise temperature each attempt; Anthropic varies the prompt instead. `loop.js` only says "attempt k".

A CORS rejection reaches JavaScript as an opaque `TypeError: Failed to fetch` — indistinguishable
from being offline and nothing like a bad key. Failures are classified into `rejected` / `quota` /
`blocked` so you are not told to re-paste a key that was fine.

**Bhashini is deliberately not wired up.** It sends no CORS headers and uses header auth; a static
page cannot call it. See `bhasha-seo/BHASHINI.md`.

## Layout

```
index.html      the tool          test.html / test.mjs   the same suite, two faces
js/app.js       DOM wiring only — no scoring, no gates, no prompts
js/guards.js    masking + gates 1-8. The safety-critical file
js/rules.js     the offline deterministic pass, and what it refuses
js/loop.js      prompts, the objective, the leaderboard
js/providers.js one interface, three code paths, N registry rows
js/detectors.js local | http | manual log
js/fetch-url.js URL import — direct read first, proxy only as fallback
```

Seven files are **vendored verbatim from `bhasha-seo`** and carry a do-not-edit-here header:
`languages.js`, `linguistics.js`, `detect.js`, `detect-en.js`, `detect-indic.js`, `protect.js` and
`fetch-url.js`.

The first six hold the calibrated constants, which are measured data rather than code — re-deriving
them would mean re-running `calibrate.py` against the source corpora. Test case 8 pins every band and
weight, so a number cannot be quietly tuned to make a demo look better. That is not hypothetical:
`bhasha-seo`'s detector scored AUC 0.21 on its first version, and the fix was measurement.

`fetch-url.js` is vendored for a different reason: it encodes measured findings about which fetch
routes actually work (r.jina.ai answered in ~0.9s and handled Devanagari; two other proxies were
broken when tested), and rewriting it would throw those away and get the privacy ordering wrong.

`package.json` contains only `{"type": "module"}` so `node test.mjs` can load the same files the
browser loads. There is no build step and no `npm install`.

## Known limits

- Only Gemini and MyMemory have been verified end-to-end from a browser. The other providers'
  preflights pass; their authenticated responses have not been exercised here.
- The Ollama and LM Studio rows are probed live, but need `OLLAMA_ORIGINS` set to this page's origin,
  and Safari blocks `https` → `http://localhost` outright.
- Under ~120 words the signals are densities over too few words to mean much. The tool says so rather
  than printing a confident number.

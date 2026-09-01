// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* languages.js — the 22 languages of the Eighth Schedule of the Indian
 * Constitution, plus Hinglish (Hindi written in Latin script).
 *
 * `script` selects the Unicode block used by the script-purity check in
 * detect-indic.js. Where a language is written in more than one script, the
 * one actually used on the Indian web is chosen and the alternative noted.
 *
 * `danda` records whether the language conventionally *can* end a sentence
 * with U+0964. It is used ONLY for sentence splitting. It is deliberately NOT
 * a humanness signal — see CALIBRATION.md, where measuring it against real BBC
 * Hindi showed the obvious rule was backwards.
 */
export const LANGUAGES = [
  { code: "hi",  name: "Hindi",     native: "हिन्दी",    script: "Devanagari", danda: true  },
  { code: "bn",  name: "Bengali",   native: "বাংলা",     script: "Bengali",    danda: true  },
  { code: "mr",  name: "Marathi",   native: "मराठी",     script: "Devanagari", danda: true  },
  { code: "te",  name: "Telugu",    native: "తెలుగు",    script: "Telugu",     danda: false },
  { code: "ta",  name: "Tamil",     native: "தமிழ்",      script: "Tamil",      danda: false },
  { code: "gu",  name: "Gujarati",  native: "ગુજરાતી",   script: "Gujarati",   danda: true  },
  { code: "kn",  name: "Kannada",   native: "ಕನ್ನಡ",     script: "Kannada",    danda: false },
  { code: "ml",  name: "Malayalam", native: "മലയാളം",   script: "Malayalam",  danda: false },
  { code: "pa",  name: "Punjabi",   native: "ਪੰਜਾਬੀ",     script: "Gurmukhi",   danda: true  },
  { code: "or",  name: "Odia",      native: "ଓଡ଼ିଆ",      script: "Oriya",      danda: true  },
  { code: "as",  name: "Assamese",  native: "অসমীয়া",    script: "Bengali",    danda: true  },
  { code: "ur",  name: "Urdu",      native: "اردو",      script: "Arabic",     danda: false, rtl: true },
  { code: "sa",  name: "Sanskrit",  native: "संस्कृतम्",   script: "Devanagari", danda: true  },
  { code: "ne",  name: "Nepali",    native: "नेपाली",     script: "Devanagari", danda: true  },
  { code: "kok", name: "Konkani",   native: "कोंकणी",    script: "Devanagari", danda: true  },
  { code: "mai", name: "Maithili",  native: "मैथिली",     script: "Devanagari", danda: true  },
  { code: "doi", name: "Dogri",     native: "डोगरी",     script: "Devanagari", danda: true  },
  { code: "brx", name: "Bodo",      native: "बड़ो",       script: "Devanagari", danda: true  },
  { code: "sd",  name: "Sindhi",    native: "سنڌي",      script: "Arabic",     danda: false, rtl: true,
    note: "Also written in Devanagari in India; Arabic script assumed here." },
  { code: "ks",  name: "Kashmiri",  native: "کٲشُر",      script: "Arabic",     danda: false, rtl: true,
    note: "Also written in Devanagari; Perso-Arabic is the official script." },
  { code: "mni", name: "Manipuri",  native: "ꯃꯤꯇꯩꯂꯣꯟ",   script: "MeiteiMayek", danda: false,
    note: "Historically written in Bengali script; Meitei Mayek is now official." },
  { code: "sat", name: "Santali",   native: "ᱥᱟᱱᱛᱟᱲᱤ",    script: "OlChiki",    danda: false },
  { code: "hinglish", name: "Hinglish", native: "Hinglish", script: "Latin", danda: false,
    note: "Hindi in Latin script. Detector runs the Latin-script signal set." },
];

/* Unicode blocks, as inclusive [start, end] codepoint pairs. */
export const SCRIPT_RANGES = {
  Devanagari:  [0x0900, 0x097F],
  Bengali:     [0x0980, 0x09FF],
  Gurmukhi:    [0x0A00, 0x0A7F],
  Gujarati:    [0x0A80, 0x0AFF],
  Oriya:       [0x0B00, 0x0B7F],
  Tamil:       [0x0B80, 0x0BFF],
  Telugu:      [0x0C00, 0x0C7F],
  Kannada:     [0x0C80, 0x0CFF],
  Malayalam:   [0x0D00, 0x0D7F],
  Arabic:      [0x0600, 0x06FF],
  OlChiki:     [0x1C50, 0x1C7F],
  MeiteiMayek: [0xABC0, 0xABFF],
  Latin:       [0x0041, 0x007A],
};

export const BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

/* Languages the calibrated Indic signal set was actually measured on.
 * Everything else runs the same code but the bands are extrapolated, so the
 * UI labels the result differently. Honesty about this is the whole point. */
export const CALIBRATED = new Set(["hi"]);

/* Script family, used to decide which calque/connective list applies when a
 * language has no list of its own. */
export const SCRIPT_FAMILY = {
  hi: "hi", mr: "mr", sa: "hi", ne: "hi", kok: "hi", mai: "hi", doi: "hi", brx: "hi",
  bn: "bn", as: "bn", gu: "gu", pa: "pa", ta: "ta", te: "te", kn: "kn",
  ml: "ml", or: "or", ur: "ur", sd: "ur", ks: "ur", mni: "bn", sat: "sat",
  hinglish: "hinglish",
};

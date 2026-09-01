// VENDORED from bhasha-seo on 2026-08-31. DO NOT EDIT HERE.
// Source of truth: C:\Claude\bhasha-seo\js$f
// These carry the calibrated constants (CALIBRATION.md). test.html asserts they have not drifted.

/* linguistics.js - per-language resources for the Indic detector.
 *
 * Every list here is a HYPOTHESIS about how machine-translated or generated
 * Indic prose gives itself away. Two of the original hypotheses were tested
 * against real text and FAILED. They are kept below, marked, rather than
 * deleted - the reasoning that produced them is the reasoning that will
 * produce the next wrong rule.
 *
 * MEASURED, native Hindi journalism vs raw MT, occurrences per 1000 words:
 *   space before punctuation   0.5  vs  29.8   <- scored
 *   prepositional calques      0.4  vs  10.7   <- scored
 *   English relative clauses   0.4  vs   3.7   <- scored
 *   comma density             22.0  vs  72.0   <- scored
 *
 * FAILED CALIBRATION, therefore NOT scored:
 *   verb-finality   native 0.921, human-translated 0.956, raw MT 0.906.
 *                   Indic NMT gets word order right. Separates nothing.
 *                   Still measured and displayed, at zero weight.
 *   danda usage     BBC Hindi, written by Hindi journalists, ends paragraphs
 *                   with U+0964 in 0% of cases. Wikipedia and raw MT: ~98%.
 *                   The rule was not merely useless, it was BACKWARDS, and
 *                   would have penalised the most native text in the sample.
 *                   Sentence-final punctuation is house style, not humanness.
 *
 * The connective / calque / formality lists below produce ACTIONABLE FLAGS
 * ("this phrase reads as translated"), and do NOT move the score. They have
 * not been separately AUC-tested, and this app never scores a signal it has
 * not measured.
 */

/* Overused discourse markers - calques of the English connectives that
 * generated prose leans on. Flagged, not scored. */
export const AI_CONNECTIVES = {
  hi: ["इसके अलावा", "इसके अतिरिक्त", "हालांकि", "इसलिए", "साथ ही", "दूसरी ओर",
       "निष्कर्ष के तौर पर", "यह ध्यान देने योग्य है", "महत्वपूर्ण है कि",
       "इस प्रकार", "अंततः", "सबसे पहले", "इसके फलस्वरूप", "उपरोक्त", "निम्नलिखित"],
  mr: ["याशिवाय", "तथापि", "म्हणून", "त्याचप्रमाणे", "दुसरीकडे", "निष्कर्षानुसार",
       "हे लक्षात घेणे महत्त्वाचे", "अशा प्रकारे", "शेवटी"],
  gu: ["વધુમાં", "જોકે", "તેથી", "તે ઉપરાંત", "બીજી બાજુ", "નિષ્કર્ષમાં",
       "એ નોંધવું મહત્વપૂર્ણ છે", "આ રીતે", "અંતે"],
  bn: ["এছাড়াও", "তবে", "অতএব", "উপরন্তু", "অন্যদিকে", "উপসংহারে",
       "এটি লক্ষ্য করা গুরুত্বপূর্ণ", "এইভাবে", "পরিশেষে"],
  ta: ["மேலும்", "இருப்பினும்", "எனவே", "கூடுதலாக", "மறுபுறம்", "முடிவாக",
       "இது குறிப்பிடத்தக்கது", "இவ்வாறு", "இறுதியாக"],
  te: ["అదనంగా", "అయితే", "కాబట్టి", "ఇంకా", "మరోవైపు", "ముగింపులో",
       "ఇది గమనించడం ముఖ్యం", "ఈ విధంగా", "చివరగా"],
  kn: ["ಇದಲ್ಲದೆ", "ಆದಾಗ್ಯೂ", "ಆದ್ದರಿಂದ", "ಜೊತೆಗೆ", "ಮತ್ತೊಂದೆಡೆ", "ಕೊನೆಯಲ್ಲಿ",
       "ಇದನ್ನು ಗಮನಿಸುವುದು ಮುಖ್ಯ", "ಈ ರೀತಿಯಾಗಿ"],
  ml: ["കൂടാതെ", "എന്നിരുന്നാലും", "അതിനാൽ", "മറുവശത്ത്", "ഉപസംഹാരമായി",
       "ഇത് ശ്രദ്ധിക്കേണ്ടതാണ്", "ഈ രീതിയിൽ", "അവസാനമായി"],
  or: ["ଏହା ବ୍ୟତୀତ", "ତଥାପି", "ତେଣୁ", "ଅନ୍ୟପକ୍ଷରେ", "ଉପସଂହାରରେ", "ଏହିପରି"],
  pa: ["ਇਸ ਤੋਂ ਇਲਾਵਾ", "ਹਾਲਾਂਕਿ", "ਇਸ ਲਈ", "ਨਾਲ ਹੀ", "ਦੂਜੇ ਪਾਸੇ", "ਸਿੱਟੇ ਵਜੋਂ",
       "ਇਹ ਧਿਆਨ ਦੇਣ ਯੋਗ ਹੈ", "ਇਸ ਤਰ੍ਹਾਂ"],
  ur: ["اس کے علاوہ", "تاہم", "لہذا", "دوسری طرف", "آخر میں", "یہ قابل ذکر ہے",
       "اس طرح", "مزید برآں"],
  hinglish: ["iske alawa", "halanki", "isliye", "saath hi", "doosri or",
             "nishkarsh", "is prakar", "antatah"],
};

/* Literal renderings of English constructions. Grammatical, but not how the
 * language is written by people. Flagged, not scored. */
export const CALQUES = {
  hi: ["यह ध्यान देने योग्य है कि", "के संदर्भ में", "के मामले में", "एक बार जब",
       "के रूप में जाना जाता है", "यह कहा जा सकता है कि", "के संबंध में",
       "इस तथ्य के कारण", "यह सुनिश्चित करें कि", "की एक विस्तृत श्रृंखला",
       "में एक महत्वपूर्ण भूमिका निभाता है", "जब बात आती है", "अपने आप में",
       "दिन के अंत में"],
  mr: ["हे लक्षात घेणे महत्त्वाचे आहे की", "च्या संदर्भात", "च्या बाबतीत",
       "म्हणून ओळखले जाते", "एक महत्त्वाची भूमिका बजावते", "ची विस्तृत श्रेणी"],
  gu: ["એ નોંધવું જોઈએ કે", "ના સંદર્ભમાં", "ના કિસ્સામાં", "તરીકે ઓળખાય છે",
       "મહત્વપૂર્ણ ભૂમિકા ભજવે છે"],
  bn: ["এটি লক্ষণীয় যে", "এর প্রসঙ্গে", "এর ক্ষেত্রে", "হিসাবে পরিচিত",
       "গুরুত্বপূর্ণ ভূমিকা পালন করে"],
  ta: ["இது குறிப்பிடத்தக்கது என்னவென்றால்", "சூழலில்", "விஷயத்தில்",
       "என அழைக்கப்படுகிறது", "முக்கிய பங்கு வகிக்கிறது"],
  te: ["ఇది గమనించదగినది", "సందర్భంలో", "విషయంలో", "అని పిలుస్తారు",
       "ముఖ్యమైన పాత్ర పోషిస్తుంది"],
  kn: ["ಇದನ್ನು ಗಮನಿಸಬೇಕು", "ಸಂದರ್ಭದಲ್ಲಿ", "ವಿಷಯದಲ್ಲಿ", "ಎಂದು ಕರೆಯಲಾಗುತ್ತದೆ",
       "ಪ್ರಮುಖ ಪಾತ್ರ ವಹಿಸುತ್ತದೆ"],
  ml: ["ഇത് ശ്രദ്ധിക്കേണ്ടതാണ്", "സന്ദർഭത്തിൽ", "കാര്യത്തിൽ",
       "എന്ന് അറിയപ്പെടുന്നു", "പ്രധാന പങ്ക് വഹിക്കുന്നു"],
  or: ["ଏହା ଲକ୍ଷ୍ୟ କରିବା ଉଚିତ", "ପ୍ରସଙ୍ଗରେ", "କ୍ଷେତ୍ରରେ", "ଭାବରେ ଜଣାଶୁଣା"],
  pa: ["ਇਹ ਧਿਆਨ ਦੇਣ ਯੋਗ ਹੈ ਕਿ", "ਦੇ ਸੰਦਰਭ ਵਿੱਚ", "ਦੇ ਮਾਮਲੇ ਵਿੱਚ",
       "ਵਜੋਂ ਜਾਣਿਆ ਜਾਂਦਾ ਹੈ", "ਮਹੱਤਵਪੂਰਨ ਭੂਮਿਕਾ ਨਿਭਾਉਂਦਾ ਹੈ"],
  ur: ["یہ قابل ذکر ہے کہ", "کے تناظر میں", "کے معاملے میں",
       "کے طور پر جانا جاتا ہے", "اہم کردار ادا کرتا ہے"],
  hinglish: ["yeh dhyan dene yogya hai", "ke sandarbh mein", "ke maamle mein",
             "ke roop mein jana jata hai"],
};

/* Heavily Sanskritised vocabulary. Correct, but the wrong register for a brand
 * that speaks plainly, and a reliable marker of dictionary-driven translation.
 * Flagged as a register warning, not scored as AI-ness. */
export const FORMAL_MARKERS = {
  hi: ["अत्यंत", "तथापि", "किंचित", "यथोचित", "एवं", "तथा", "हेतु", "उपरांत",
       "परिलक्षित", "प्रयुक्त", "समुचित", "तत्पश्चात", "विद्यमान",
       "आवश्यकतानुसार", "उल्लेखनीय", "प्रतीत", "स्वास्थ्यवर्धक"],
  mr: ["अत्यंत", "तथापि", "एवं", "तथा", "उपरांत", "प्रयुक्त", "समुचित"],
  gu: ["અત્યંત", "તથાપિ", "એવં", "તથા", "ઉપરાંત"],
  bn: ["অত্যন্ত", "তথাপি", "এবং", "তথা", "উপরন্তু", "প্রযুক্ত"],
  ta: ["மிகவும்", "ஆயினும்", "மேலும்", "எனவே"],
  te: ["అత్యంత", "అయినప్పటికీ", "మరియు", "తథా"],
  kn: ["ಅತ್ಯಂತ", "ಆದಾಗ್ಯೂ", "ಮತ್ತು", "ತಥಾ"],
  ml: ["അത്യന്തം", "എന്നിരുന്നാലും", "കൂടാതെ"],
  or: ["ଅତ୍ୟନ୍ତ", "ତଥାପି", "ଏବଂ"],
  pa: ["ਅਤਿਅੰਤ", "ਤਥਾਪਿ", "ਏਵੰ", "ਤਥਾ"],
  ur: ["نہایت", "تاہم", "نیز"],
  hinglish: ["atyant", "tathapi", "evam", "tatha", "hetu"],
};

/* Politeness levels. Mixing them inside one document is a real defect in
 * customer-facing copy. Untested by news/encyclopedia fixtures (neither
 * addresses a reader), so this is reported as a flag at zero weight. */
export const HONORIFICS = {
  hi: { formal: ["आप", "आपको", "आपका", "आपकी", "आपके"],
        informal: ["तुम", "तुम्हें", "तुम्हारा", "तुम्हारी"],
        intimate: ["तू", "तुझे", "तेरा", "तेरी"] },
  mr: { formal: ["तुम्ही", "तुम्हाला", "तुमचा", "तुमची"],
        informal: ["तू", "तुला", "तुझा", "तुझी"], intimate: [] },
  gu: { formal: ["તમે", "તમને", "તમારું", "તમારી"],
        informal: ["તું", "તને", "તારું"], intimate: [] },
  bn: { formal: ["আপনি", "আপনার", "আপনাকে"],
        informal: ["তুমি", "তোমার", "তোমাকে"], intimate: ["তুই", "তোর"] },
  ta: { formal: ["நீங்கள்", "உங்கள்", "உங்களுக்கு"],
        informal: ["நீ", "உன்", "உனக்கு"], intimate: [] },
  te: { formal: ["మీరు", "మీ", "మీకు"], informal: ["నువ్వు", "నీ", "నీకు"], intimate: [] },
  kn: { formal: ["ನೀವು", "ನಿಮ್ಮ", "ನಿಮಗೆ"], informal: ["ನೀನು", "ನಿನ್ನ", "ನಿನಗೆ"], intimate: [] },
  ml: { formal: ["നിങ്ങൾ", "നിങ്ങളുടെ"], informal: ["നീ", "നിന്റെ"], intimate: [] },
  pa: { formal: ["ਤੁਸੀਂ", "ਤੁਹਾਡਾ", "ਤੁਹਾਨੂੰ"], informal: ["ਤੂੰ", "ਤੇਰਾ", "ਤੈਨੂੰ"], intimate: [] },
  ur: { formal: ["آپ", "آپ کا", "آپ کو"], informal: ["تم", "تمہارا"], intimate: ["تو"] },
  hinglish: { formal: ["aap", "aapko", "aapka", "aapki"],
              informal: ["tum", "tumhe", "tumhara"], intimate: ["tu", "tujhe", "tera"] },
};

/* DIAGNOSTIC ONLY - zero weight. See the header: verb-finality separated
 * nothing (0.921 / 0.956 / 0.906). Kept because it is worth showing a user
 * who wants to know why word order is not being scored. */
export const VERB_ENDINGS = {
  hi: ["है", "हैं", "था", "थी", "थे", "हो", "हूँ", "हूं", "गा", "गी", "गे", "ता", "ती",
       "ते", "या", "ये", "ना", "नी", "ने", "कर", "चाहिए", "सकता", "सकती", "सकते",
       "रहा", "रही", "रहे", "दें", "करें", "जाए", "जाता", "जाती", "होता", "होती",
       "होते", "लें", "पड़ता", "पड़ती"],
  mr: ["आहे", "आहेत", "होता", "होती", "होते", "नाही", "करा", "करावे", "शकते",
       "शकतो", "जाते", "जातो", "असते", "असतो", "लागते", "येते", "पाहिजे", "हवे"],
  gu: ["છે", "હતું", "હતા", "હતી", "થાય", "કરો", "શકે", "શકાય", "જોઈએ", "આવે", "રહે"],
  bn: ["করে", "হয়", "ছিল", "আছে", "যায়", "করুন", "হবে", "থাকে", "পারে", "উচিত"],
  ta: ["கிறது", "ஆகும்", "உள்ளது", "வேண்டும்", "இருக்கும்", "படும்", "முடியும்", "இல்லை"],
  te: ["ఉంది", "అవుతుంది", "చేయండి", "ఉన్నాయి", "కావచ్చు", "చేస్తుంది", "లేదు"],
  kn: ["ಇದೆ", "ಆಗುತ್ತದೆ", "ಮಾಡಿ", "ಬಹುದು", "ಇವೆ", "ಆಗಿದೆ", "ಇಲ್ಲ"],
  ml: ["ആണ്", "ഉണ്ട്", "ചെയ്യുക", "കഴിയും", "ഇല്ല"],
  pa: ["ਹੈ", "ਹਨ", "ਸੀ", "ਕਰੋ", "ਸਕਦਾ", "ਸਕਦੀ", "ਸਕਦੇ", "ਚਾਹੀਦਾ", "ਹੁੰਦਾ"],
  hinglish: ["hai", "hain", "tha", "thi", "the", "hoga", "hogi", "karein",
             "sakta", "sakti", "sakte", "raha", "rahi", "rahe", "chahiye"],
};

/* SCORED. Prepositional calques - literal renderings of "as", "by", "through".
 * Native Hindi 0.4/1k, raw MT 10.7/1k. */
export const PREP_CALQUES = {
  hi: ["के रूप में", "के द्वारा", "के माध्यम से"],
  mr: ["च्या रूपात", "द्वारे", "च्या माध्यमातून"],
  gu: ["ના રૂપમાં", "દ્વારા", "ના માધ્યમથી"],
  bn: ["হিসাবে", "দ্বারা", "মাধ্যমে"],
  pa: ["ਦੇ ਰੂਪ ਵਿੱਚ", "ਦੁਆਰਾ", "ਦੇ ਮਾਧਿਅਮ ਨਾਲ"],
  ta: ["ஆக", "மூலம்"],
  te: ["రూపంలో", "ద్వారా"],
  kn: ["ರೂಪದಲ್ಲಿ", "ಮೂಲಕ"],
  ml: ["രൂപത്തിൽ", "മുഖേന"],
  or: ["ରୂପରେ", "ମାଧ୍ୟମରେ"],
  ur: ["کے طور پر", "کے ذریعے"],
  hinglish: ["ke roop mein", "ke dwara", "ke madhyam se"],
};

/* SCORED. English-shaped relative clauses - "X, जो ... है" mirrors
 * "X, which is ...". Native writing splits the sentence or uses a participle.
 * Native 0.4/1k, raw MT 3.7/1k. */
export const RELATIVE_MARKERS = {
  hi: ["जो", "जिसे", "जिसमें", "जिससे", "जिसका", "जिसकी"],
  mr: ["जो", "जे", "ज्याला", "ज्यामध्ये"],
  gu: ["જે", "જેને", "જેમાં"],
  bn: ["যা", "যাকে", "যেখানে", "যার"],
  pa: ["ਜੋ", "ਜਿਸ", "ਜਿਸਨੂੰ", "ਜਿਸ ਵਿੱਚ"],
  ta: ["எது", "எந்த"],
  te: ["ఏది", "ఎవరు"],
  kn: ["ಯಾವ", "ಯಾರು"],
  ml: ["ഏത്", "ആര്"],
  or: ["ଯାହା", "ଯେଉଁ"],
  ur: ["جو", "جسے", "جس میں"],
  hinglish: ["jo", "jise", "jismein", "jisse"],
};

/* Look up a table by language, falling back to the script family. Returns []
 * rather than undefined so callers can just map over the result. */
export function forLang(table, lang, family) {
  if (table[lang]) return table[lang];
  if (family && table[family]) return table[family];
  return [];
}

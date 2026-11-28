const SKIP_RE = /^[\s♪♫♩♬…·\-–—]*$/;

const HANGUL_RE = /\p{Script=Hangul}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const HAN_RE = /\p{Script=Han}/u;

// A line is treated as already written in the target language when more than half of its letters are in that script (LRCLIB lyrics carry no language info).
// Mixed lines like "Baby 너만 보여", or lines with more English, get translated.
const SCRIPT_CHECKS = {
  KO: (letters, count) => count(HANGUL_RE) * 2 > letters.length,
  JA: (letters, count) => count(KANA_RE) > 0 && (count(KANA_RE) + count(HAN_RE)) * 2 > letters.length
};

function hasScriptCheck(targetLang) {
  return targetLang.split('-')[0] in SCRIPT_CHECKS;
}

function isInTargetLang(text, targetLang) {
  const check = SCRIPT_CHECKS[targetLang.split('-')[0]];
  const letters = check && text.match(/\p{L}/gu);
  if (!letters) return false;
  return check(letters, re => letters.filter(c => re.test(c)).length);
}

function isTranslatable(text, targetLang) {
  return typeof text === 'string' && !SKIP_RE.test(text) && !(targetLang && isInTargetLang(text, targetLang));
}

const LANG_NAMES = { KO: 'Korean', JA: 'Japanese', ZH: 'Chinese (Simplified)', 'EN-US': 'English' };

function registerRule(targetLang, register) {
  const lang = targetLang.split('-')[0];
  if (lang === 'KO') {
    return register === 'polite'
      ? 'Use 해요체 (polite -요 endings) in every line of the song. Never switch to 반말 or 합쇼체 (-습니다).'
      : 'Use 반말 (해체/해라체: -아, -어, -지, -야, -다 endings) in every line of the song. Never use -요, -습니다, -세요.';
  }
  if (lang === 'JA') {
    return register === 'polite'
      ? 'Use です/ます polite style in every line of the song. Never mix in plain form.'
      : 'Use plain form (常体, だ/る endings) in every line of the song. Never mix in です/ます.';
  }
  return register === 'polite'
    ? 'Use a consistently polite, formal tone across the whole song.'
    : 'Use a consistently casual, natural tone across the whole song.';
}

export { isTranslatable, isInTargetLang, hasScriptCheck, registerRule, LANG_NAMES };

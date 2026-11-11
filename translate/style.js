const SKIP_RE = /^[\s♪♫♩♬…·\-–—]*$/;

const HANGUL_RE = /\p{Script=Hangul}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const HAN_RE = /\p{Script=Han}/u;

// 글자의 절반 넘게 대상 언어 문자면 이미 그 언어로 쓰인 줄로 본다 (LRCLIB 가사엔 언어 정보가 없다).
// "Baby 너만 보여" 처럼 반반이거나 영어가 더 많은 줄은 번역한다.
// ZH 는 번체·일본어 한자와, EN 은 다른 라틴 문자 언어와 구분이 안 돼서 판별하지 않는다.
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

// register: 'casual' | 'polite'
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

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'lk', 'lm', 'lp', 'l', 'l', 'lp', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];

const KANA_PAIRS = `あ a い i う u え e お o か ka き ki く ku け ke こ ko さ sa し shi す su せ se そ so
た ta ち chi つ tsu て te と to な na に ni ぬ nu ね ne の no は ha ひ hi ふ fu へ he ほ ho ま ma み mi む mu め me も mo
や ya ゆ yu よ yo ら ra り ri る ru れ re ろ ro わ wa ゐ i ゑ e を o ん n が ga ぎ gi ぐ gu げ ge ご go ざ za じ ji ず zu
ぜ ze ぞ zo だ da ぢ ji づ zu で de ど do ば ba び bi ぶ bu べ be ぼ bo ぱ pa ぴ pi ぷ pu ぺ pe ぽ po ぁ a ぃ i ぅ u ぇ e ぉ o
ゔ vu`.trim().split(/\s+/);
const KANA = Object.fromEntries(KANA_PAIRS.filter((_, i) => i % 2 === 0).map((k, i) => [k, KANA_PAIRS[i * 2 + 1]]));
const SMALL_Y = { 'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o' };

const HANGUL_FIRST = 0xAC00;
const HANGUL_LAST = 0xD7A3;
const KATAKANA_FIRST = 0x30A1;
const KATAKANA_LAST = 0x30F6;
const KANA_OFFSET = 0x60;

const HANGUL = /\p{Script=Hangul}/u;
const KANA_CHAR = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;

const isSyllable = code => code >= HANGUL_FIRST && code <= HANGUL_LAST;
const toHiragana = c => {
  const code = c.codePointAt(0);
  return code >= KATAKANA_FIRST && code <= KATAKANA_LAST ? String.fromCodePoint(code - KANA_OFFSET) : c;
};

function romanizeHangul(code) {
  const i = code - HANGUL_FIRST;
  return INITIALS[Math.floor(i / 588)] + MEDIALS[Math.floor((i % 588) / 28)] + FINALS[i % 28];
}

function romanize(text) {
  let out = '';
  let doubleNext = false;
  for (const raw of text) {
    const c = toHiragana(raw);
    if (isSyllable(c.codePointAt(0))) {
      out += romanizeHangul(c.codePointAt(0));
    } else if (c === 'っ') {
      doubleNext = true;
      continue;
    } else if (c === 'ー') {
      out += out.match(/[aeiou]$/)?.[0] || '';
    } else if (SMALL_Y[c] && out.endsWith('i')) {
      out = out.slice(0, -1) + (/(sh|ch|j)i$/.test(out) ? '' : 'y') + SMALL_Y[c];
    } else if (KANA[c]) {
      out += doubleNext ? KANA[c][0] + KANA[c] : KANA[c];
    } else {
      out += c;
    }
    doubleNext = false;
  }
  return out;
}

const hasRomanizable = s => HANGUL.test(s) || KANA_CHAR.test(s);
const hasHan = s => HAN.test(s);

export { hasHan, hasRomanizable, romanize };

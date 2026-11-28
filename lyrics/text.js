// Text helpers shared by the lyrics sources.

import { hasHan, hasRomanizable, romanize } from './romanize.js';

function plainLines(text) {
  return text.split(/\r?\n/).map(t => ({ startTimeMs: 0, text: t.trim() })).filter(l => l.text);
}

// Strips tails such as "Song - Remastered 2011", "Song (feat. X)", "曲（2005LIVE）" (for searching).
// Needs a word boundary: "(Alive)" and "Olive" are not version markers. A digit directly attached, as in "2005LIVE", is allowed.
const VERSION = '(?<![a-z])(?:remaster(?:ed)?|version|ver\\.|live|edit|re-?mix|mix|mono|stereo|acoustic)(?![a-z])';
const VERSION_TAIL = new RegExp(`\\s+-\\s+.*${VERSION}.*$`, 'i');
const VERSION_PAREN = new RegExp(`\\s*[([][^)\\]]*${VERSION}[^)\\]]*[)\\]]`, 'i');

function cleanTitle(title) {
  return title.normalize('NFKC')
    .replace(VERSION_TAIL, '')
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/i, '')
    .replace(VERSION_PAREN, '')
    .trim();
}

const norm = s => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// Ignores version and feat tails when comparing. A partial match counts as a different song.
const titleKeys = title => {
  const clean = cleanTitle(title || '');
  const bilingual = parenthesized(clean);
  const translated = bilingual && NON_LATIN.test(bilingual[1]) !== NON_LATIN.test(bilingual[2]);
  return [clean, ...(translated ? [bilingual[1], bilingual[2]] : [])].map(norm).filter(Boolean);
};

const sameTitle = (a, b) => {
  const ours = titleKeys(b);
  return titleKeys(a).some(k => ours.includes(k));
};

const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const CREDIT_SEPARATOR = /\s*(?:[,&/;×、]|\s(?:feat|ft)\.?\s|\s(?:with|and|x|vs\.?)\s)\s*/i;

const stripMarks = s => s.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC');
const artistKey = s => norm(stripMarks(s).trim().replace(/^the\s+/i, ''));
const latinTokens = s => stripMarks(s).toLowerCase().replace(/^the\s+/, '').split(/[^a-z0-9]+/).filter(Boolean);

const LONG_VOWEL = /ou|oo|oh(?=[^aeiou]|$)|uu/g;
const LONG_VOWEL_SHORT = { ou: 'o', oo: 'o', oh: 'o', uu: 'u' };
const mildKeys = tokens => {
  const short = tokens.map(t => t.replace(LONG_VOWEL, m => LONG_VOWEL_SHORT[m]));
  return [short.join(''), [...short].reverse().join('')];
};

const VOWEL_FOLDS = [[/eo/g, 'u'], [/eu/g, 'u'], [/(ae|oe|oi|ei)/g, 'e'], [/(ui|yi|ee|ea)/g, 'i'], [/(oo|uu|ou)/g, 'u']];
function skeleton(latin) {
  let s = latin.replace(/ph/g, 'p').replace(/th/g, 't').replace(/kh/g, 'k').replace(/sh/g, 's')
    .replace(/ch|j|z/g, 'c').replace(/f/g, 'h').replace(/[kq]/g, 'g').replace(/[pv]/g, 'b').replace(/t/g, 'd').replace(/r/g, 'l');
  for (const [from, to] of VOWEL_FOLDS) s = s.replace(from, to);
  s = s.replace(/h/g, '').replace(/(.)\1+/g, '$1').replace(/^[ly]+/, '').replace(/([aeiou])l(?=[^aeiouy]|$)/g, '$1');
  return s.length >= 3 ? s : '';
}

function soundKeys(name) {
  if (hasHan(name)) return { mild: [], sound: [], script: 'han' };
  if (hasRomanizable(name)) {
    const latin = latinTokens(romanize(name.normalize('NFKC'))).join('');
    return { mild: [], sound: [...new Set([skeleton(latin), skeleton(mildKeys([latin])[0])])].filter(Boolean), script: 'native' };
  }
  if (NON_LATIN.test(name)) return { mild: [], sound: [], script: 'other' };
  const tokens = latinTokens(name);
  const mild = tokens.length ? mildKeys(tokens) : [];
  const silentE = tokens.map(t => t.replace(/([^aeiouy])e$/, '$1'));
  const raw = [tokens.join(''), [...tokens].reverse().join(''), silentE.join(''), [...silentE].reverse().join('')];
  return { mild, sound: [...new Set([...raw, ...mild].map(skeleton))].filter(Boolean), script: 'latin' };
}

const parenthesized = s => /^(.*?)\s*[([（]([^()[\]（）]+)[)\]）]\s*$/.exec(s);

const creditNames = credit => {
  const parts = (credit || '').split(CREDIT_SEPARATOR).flatMap(p => {
    const inner = parenthesized(p);
    return inner ? [inner[1], inner[2]] : [p];
  });
  return [credit || '', ...parts].map(p => p.trim()).filter(Boolean);
};

const ARTIST_EXACT = 2;
const ARTIST_SOUNDS_LIKE = 1;

function artistMatch(theirs, ours) {
  const names = creditNames(theirs);
  const keys = new Set(names.map(artistKey).filter(Boolean));
  if (ours.some(o => keys.has(artistKey(o || '')))) return ARTIST_EXACT;
  for (const n of names) {
    const a = soundKeys(n);
    for (const o of ours) {
      const b = soundKeys(o || '');
      if (a.mild.some(k => b.mild.includes(k))) return ARTIST_SOUNDS_LIKE;
      if (a.script !== b.script && a.sound.some(k => b.sound.includes(k))) return ARTIST_SOUNDS_LIKE;
    }
  }
  return 0;
}

const sameArtist = (theirs, ours) => artistMatch(theirs, ours) === ARTIST_EXACT;

const splitArtists = artist => artist.split(/,\s*/).map(a => a.trim()).filter(Boolean);

export { ARTIST_EXACT, ARTIST_SOUNDS_LIKE, NON_LATIN, artistKey, artistMatch, cleanTitle, creditNames, norm, plainLines, sameArtist, sameTitle, splitArtists };

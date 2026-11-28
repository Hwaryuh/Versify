import { fetchJson } from './http.js';
import { ARTIST_EXACT, NON_LATIN, artistKey, artistMatch, creditNames, splitArtists } from './text.js';

const CACHE_PREFIX = 'artistAliases:';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOOKED_UP_ARTISTS = 3;
const MAX_CREDIT_LOOKUPS = 3;
const MAX_SEARCH_NAMES = 2;

const memory = new Map();
const storage = () => globalThis.chrome?.storage?.local;

async function cachedAliases(key) {
  if (memory.has(key)) return memory.get(key);
  let stored = null;
  try {
    stored = await storage()?.get(CACHE_PREFIX + key);
  } catch (_) {}
  const hit = stored?.[CACHE_PREFIX + key];
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  memory.set(key, hit.names);
  return hit.names;
}

function remember(key, names) {
  memory.set(key, names);
  try {
    storage()?.set({ [CACHE_PREFIX + key]: { names, at: Date.now() } }).catch(() => {});
  } catch (_) {}
}

async function aliasesOf(name) {
  const key = artistKey(name);
  if (!key) return [];
  const cached = await cachedAliases(key);
  if (cached) return cached;
  const url = new URL('https://musicbrainz.org/ws/2/artist');
  const quoted = `"${name.replace(/["\\]/g, '')}"`;
  url.searchParams.set('query', `artist:${quoted} OR alias:${quoted}`);
  url.searchParams.set('limit', '5');
  url.searchParams.set('fmt', 'json');
  let data;
  try {
    data = await fetchJson(url);
  } catch (_) {
    return [];
  }
  const names = [];
  for (const a of data?.artists || []) {
    const all = [a.name, a['sort-name'], ...(a.aliases || []).map(x => x.name)].filter(Boolean);
    if (!all.some(n => artistKey(n) === key)) continue;
    for (const n of all) if (!names.includes(n)) names.push(n);
  }
  remember(key, names);
  return names;
}

const sameScript = (a, b) => NON_LATIN.test(a) === NON_LATIN.test(b);

async function knownArtists(artist) {
  const spotify = splitArtists(artist);
  const names = [...spotify];
  let searchNames = [];
  for (const [i, name] of spotify.slice(0, MAX_LOOKED_UP_ARTISTS).entries()) {
    const aliases = await aliasesOf(name);
    for (const a of aliases) if (!names.includes(a)) names.push(a);
    if (i === 0) searchNames = aliases.filter(a => !sameScript(a, name) && !spotify.includes(a)).slice(0, MAX_SEARCH_NAMES);
  }
  return { names, searchNames, creditLookups: 0 };
}

async function learnFromCredits(credits, known) {
  const unknown = [...new Set(credits.filter(Boolean))]
    .filter(c => !artistMatch(c, known.names))
    .flatMap(creditNames)
    .filter(n => !known.names.some(k => sameScript(k, n)) || NON_LATIN.test(n));
  for (const name of [...new Set(unknown)]) {
    if (known.creditLookups >= MAX_CREDIT_LOOKUPS) return;
    known.creditLookups++;
    const aliases = await aliasesOf(name);
    if (!aliases.some(a => artistMatch(a, known.names) === ARTIST_EXACT)) continue;
    for (const a of [name, ...aliases]) if (!known.names.includes(a)) known.names.push(a);
  }
}

export { knownArtists, learnFromCredits };

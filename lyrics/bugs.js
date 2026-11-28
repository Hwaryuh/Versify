// Bugs (unofficial endpoint, personal use). Supplements Korean songs missing from LRCLIB.

import { fetchWithTimeout, waitRetryAfter } from './http.js';
import { learnFromCredits } from './artists.js';
import { ARTIST_EXACT, artistMatch, cleanTitle, norm, plainLines, sameTitle } from './text.js';

const BASE = 'https://music.bugs.co.kr';
const MAX_CANDIDATES = 3;

// The first request without a cookie gets 429 + Set-Cookie. Retry once with the cookie.
async function fetchText(url, headers = {}, retry = true) {
  const { res, body } = await fetchWithTimeout(url, { headers, credentials: 'include' }, r => r.text());
  if (res.ok) return body;
  if (res.status === 429 && retry) {
    await waitRetryAfter(res, 2);
    return fetchText(url, headers, false);
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decode(m[1] ?? m[2]) : null;
};

function parseSearch(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (attr(m[1], 'rowType') !== 'track') continue;
    const id = attr(m[1], 'trackId');
    const body = m[2];
    const titleTag = /<p\b[^>]*class="title"[^>]*>\s*<a\b([^>]*)>/i.exec(body);
    const title = titleTag && attr(titleTag[1], 'title');
    if (!/^\d+$/.test(id || '') || !title) continue;
    const artistBlock = /<p\b[^>]*class="artist"[^>]*>([\s\S]*?)<\/p>/i.exec(body)?.[1] || '';
    const artists = [...artistBlock.matchAll(/<a\b([^>]*)>/gi)].map(a => attr(a[1], 'title')).filter(Boolean);
    const albumTag = /<a\b([^>]*class="album"[^>]*)>/i.exec(body);
    rows.push({ id, title, artists, album: (albumTag && attr(albumTag[1], 'title')) || '' });
  }
  return rows;
}

// "4.6|first line＃8.0|second line" (seconds|line, separated by the full-width ＃). Malformed pieces are dropped.
function parseSynced(text) {
  const lines = [];
  for (const part of text.split('＃')) {
    const m = /^\s*(\d+(?:\.\d+)?)\|([\s\S]*)$/.exec(part);
    if (m) lines.push({ startTimeMs: Math.round(parseFloat(m[1]) * 1000), text: m[2].trim() });
  }
  return lines.some(l => l.text) ? lines.sort((a, b) => a.startTimeMs - b.startTimeMs) : [];
}

function parseDuration(html) {
  const m = /"duration"\s*:\s*"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/.exec(html);
  if (!m || !(m[1] || m[2] || m[3])) return 0;
  return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0);
}

async function lyricsJson(kind, id) {
  const body = await fetchText(`${BASE}/player/lyrics/${kind}/${id}`, { 'X-Requested-With': 'XMLHttpRequest' });
  try {
    const lyrics = body && JSON.parse(body).lyrics;
    return typeof lyrics === 'string' ? lyrics : '';
  } catch (_) {
    return '';
  }
}

async function fetchBugs({ title, album, durationMs }, known) {
  const query = cleanTitle(title);
  const wanted = norm(query);
  if (!wanted) return null;
  const durationSec = durationMs ? Math.round(durationMs / 1000) : 0;
  const ourAlbum = norm(album || '') === wanted ? '' : norm(album || '');

  // A common title searched alone may not list the song in the top 50: search title + artist first, then title only.
  const findCandidates = async q => {
    const html = await fetchText(`${BASE}/search/track?q=${encodeURIComponent(q)}`);
    const rows = (html ? parseSearch(html) : []).filter(r => sameTitle(r.title, title));
    await learnFromCredits(rows.flatMap(r => r.artists), known);
    return rows
      .map(r => ({ ...r, artistLevel: Math.max(0, ...r.artists.map(a => artistMatch(a, known.names))), albumMatch: !!ourAlbum && norm(r.album) === ourAlbum }))
      .filter(c => c.artistLevel || c.albumMatch)
      .sort((a, b) => (b.artistLevel + b.albumMatch) - (a.artistLevel + a.albumMatch))
      .slice(0, MAX_CANDIDATES);
  };
  let candidates = [];
  for (const name of [known.names[0], ...known.searchNames].filter(Boolean)) {
    candidates = await findCandidates(`${query} ${name}`);
    if (candidates.length) break;
  }
  if (!candidates.length) candidates = await findCandidates(query);

  // Songs sharing a title are common. Consider only candidates whose artist or album matches;
  // with a known duration it must match within 3s; without one, only an exactly equal artist name is accepted (album alone is not enough evidence).
  // Candidates whose artist and album both differ are never used, even if the duration matches.
  let match = null;
  for (const c of candidates) {
    if (!durationSec) {
      if (c.artistLevel === ARTIST_EXACT) { match = c; break; }
      continue;
    }
    const page = await fetchText(`${BASE}/track/${c.id}`);
    const sec = page ? parseDuration(page) : 0;
    if (sec && Math.abs(sec - durationSec) <= 3) { match = c; break; }
  }
  if (!match) return null;

  const synced = parseSynced(await lyricsJson('T', match.id));
  if (synced.length) return { lines: synced, synced: true, source: 'bugs' };
  const plain = plainLines(await lyricsJson('N', match.id));
  return plain.length ? { lines: plain, synced: false, source: 'bugs' } : null;
}

export { fetchBugs, parseSearch, parseSynced, parseDuration };

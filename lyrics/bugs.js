// 벅스 (비공식 엔드포인트, 개인용). LRCLIB 에 없는 한국 곡 보충용
// 반환: { lines: [{ startTimeMs, text }], synced, source: 'bugs' } | null. 장애는 null 로 삼킨다 (다음 소스로 진행)

import { fetchWithTimeout, waitRetryAfter } from './http.js';
import { cleanTitle, norm, plainLines, sameTitle } from './text.js';

const BASE = 'https://music.bugs.co.kr';
const MAX_CANDIDATES = 3;

// 벅스는 쿠키 없는 첫 요청에 429 + Set-Cookie 를 주고, 쿠키를 들고 다시 오면 200 을 준다.
// 한 번만 쿠키(credentials)를 받아 재시도한다
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

// 검색 결과 HTML -> [{ id, title, artists, album }]. trackId 나 제목이 없는 행은 버린다
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

// "4.6|하얀 섬＃8.0|우리 그 위에 집을 짓자" (초|줄, 전각 ＃ 구분). 형식이 틀린 조각은 버린다
function parseSynced(text) {
  const lines = [];
  for (const part of text.split('＃')) {
    const m = /^\s*(\d+(?:\.\d+)?)\|([\s\S]*)$/.exec(part);
    if (m) lines.push({ startTimeMs: Math.round(parseFloat(m[1]) * 1000), text: m[2].trim() });
  }
  return lines.some(l => l.text) ? lines.sort((a, b) => a.startTimeMs - b.startTimeMs) : [];
}

// 트랙 페이지 JSON-LD "duration": "PT1M56S" -> 초
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

async function fetchBugs({ title, artist, album, durationMs }) {
  const query = cleanTitle(title);
  const wanted = norm(query);
  if (!wanted) return null;
  const durationSec = durationMs ? Math.round(durationMs / 1000) : 0;
  const ourArtists = artist.split(/,\s*/).map(norm).filter(Boolean);
  const ourAlbum = norm(album || '');

  // "연애" 같은 흔한 제목은 제목만 검색하면 상위 50건에 원하는 곡이 없다 -> 제목 + 아티스트로 먼저 검색하고,
  // 후보가 없으면 제목만으로 다시 (아티스트 표기가 달라도 앨범이 맞는 후보를 찾는다)
  const findCandidates = async q => {
    const html = await fetchText(`${BASE}/search/track?q=${encodeURIComponent(q)}`);
    return (html ? parseSearch(html) : [])
      .filter(r => sameTitle(r.title, title))
      .map(r => ({ ...r, artistMatch: r.artists.some(a => ourArtists.includes(norm(a))), albumMatch: !!ourAlbum && norm(r.album) === ourAlbum }))
      .filter(c => c.artistMatch || c.albumMatch)
      .sort((a, b) => (b.artistMatch + b.albumMatch) - (a.artistMatch + a.albumMatch))
      .slice(0, MAX_CANDIDATES);
  };
  const firstArtist = artist.split(/,\s*/)[0].trim();
  let candidates = firstArtist ? await findCandidates(`${query} ${firstArtist}`) : [];
  if (!candidates.length) candidates = await findCandidates(query);

  // 같은 제목의 다른 곡이 흔하다 ("하얀 섬": 이희상, Sagi, ...). 아티스트나 앨범이 맞는 후보만 보고,
  // 길이를 알면 ±3초 일치가 필수, 모르면 아티스트 이름이 정확히 같을 때만 쓴다 (앨범명만으로는 근거 부족).
  // 아티스트·앨범이 안 맞는 후보는 길이가 맞아도 쓰지 않는다 ("연애" 같은 흔한 제목에서 오탐)
  let match = null;
  for (const c of candidates) {
    if (!durationSec) {
      if (c.artistMatch) { match = c; break; }
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

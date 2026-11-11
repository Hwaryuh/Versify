// lrclib.net (무료, 키 없음, LRC 싱크 가사) -> 실패 시 lyrics.ovh (plain)
// 반환: { lines: [{ startTimeMs, text }], synced, source } | null

import { t } from '../i18n.js';

const UA = 'SpotifyLyricsTranslator/2.0';

async function fetchJson(url, headers = {}, retry = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 404) return null;
    if (res.ok) return await res.json();
  } finally {
    clearTimeout(timeout);
  }
  // lrclib 은 DB 에 없는 곡을 밖에서 찾다가 바쁘면 404 대신 503 + retry-after 를 준다 -> 한 번만 기다렸다 다시
  if (res.status === 503 && retry) {
    const wait = Math.min(Number(res.headers?.get('retry-after')) || 1, 3);
    await new Promise(r => setTimeout(r, wait * 1000));
    return fetchJson(url, headers, false);
  }
  throw new Error(`HTTP ${res.status}`);
}

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const head = /^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/.exec(raw);
    if (!head) continue;
    const text = raw.slice(head[0].length).trim();
    for (const t of head[0].matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)) {
      const sec = parseInt(t[2], 10);
      if (sec > 59) continue;
      const frac = t[3] ? parseInt(t[3].padEnd(3, '0'), 10) : 0;
      lines.push({ startTimeMs: (parseInt(t[1], 10) * 60 + sec) * 1000 + frac, text });
    }
  }
  return lines.sort((a, b) => a.startTimeMs - b.startTimeMs);
}

function plainLines(text) {
  return text.split(/\r?\n/).map(t => ({ startTimeMs: 0, text: t.trim() })).filter(l => l.text);
}

function fromRecord(rec) {
  if (!rec || rec.instrumental) return null;
  if (rec.syncedLyrics) {
    const lines = parseLrc(rec.syncedLyrics);
    if (lines.length) return { lines, synced: true, source: 'lrclib' };
  }
  if (rec.plainLyrics) {
    const lines = plainLines(rec.plainLyrics);
    if (lines.length) return { lines, synced: false, source: 'lrclib' };
  }
  return null;
}

// 길이가 안 맞는 레코드(원곡 vs 라이브 등)는 싱크가 어긋나므로 시각을 버리고 텍스트만 쓴다
function unsynced(rec) {
  if (!rec || rec.instrumental) return null;
  const lines = plainLines(rec.plainLyrics || parseLrc(rec.syncedLyrics || '').map(l => l.text).join('\n'));
  return lines.length ? { lines, synced: false, source: 'lrclib' } : null;
}

// "Song - Remastered 2011", "Song (feat. X)", "曲（2005LIVE）" 같은 꼬리 제거 (검색용).
// NFKC 로 전각 괄호·영숫자를 반각으로 맞춘다
// 글자 경계 필수: "(Alive)", "Olive" 는 버전 표기가 아니다. "2005LIVE" 처럼 숫자 붙은 건 허용
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

const isVersionVariant = title => VERSION_TAIL.test(title.normalize('NFKC')) || VERSION_PAREN.test(title.normalize('NFKC'));

// Spotify 는 아티스트명을 로마자로 바꿔 보여주기도 한다("尾崎豊" -> "Yutaka Ozaki").
// MusicBrainz 별칭에서 입력과 정확히 같은 이름을 가진 아티스트를 찾아 비라틴 문자 이름을 돌려준다.
// ponytail: 캐시는 서비스 워커 메모리만. 워커가 내려가면 다시 조회 (아티스트당 1회라 충분)
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const nativeNameCache = new Map();

async function nativeArtistNames(artist) {
  const key = artist.toLowerCase();
  if (!key || NON_LATIN.test(artist)) return [];
  if (nativeNameCache.has(key)) return nativeNameCache.get(key);
  const url = new URL('https://musicbrainz.org/ws/2/artist');
  const quoted = `"${artist.replace(/["\\]/g, '')}"`;
  url.searchParams.set('query', `artist:${quoted} OR alias:${quoted}`);
  url.searchParams.set('limit', '5');
  url.searchParams.set('fmt', 'json');
  let data;
  try {
    data = await fetchJson(url);
  } catch (_) {
    return []; // MusicBrainz 장애는 가사 검색을 막지 않는다. 실패는 캐시하지 않음
  }
  if (!data) return [];
  const names = new Set();
  for (const a of data?.artists || []) {
    const all = [a.name, ...(a.aliases || []).map(x => x.name)].filter(Boolean);
    if (!all.some(n => n.toLowerCase() === key)) continue;
    for (const n of all) if (NON_LATIN.test(n)) names.add(n);
  }
  const result = [...names].slice(0, 2); // 대표 이름이 앞에 온다. lrclib 호출 수 제한
  nativeNameCache.set(key, result);
  return result;
}

async function fetchLrclib({ title, artist, album, durationMs }) {
  const headers = { 'Lrclib-Client': UA };
  const durationSec = durationMs ? Math.round(durationMs / 1000) : 0;

  // 한 단계가 실패해도 다음 단계로 진행하고, 끝까지 못 찾으면 그 오류를 던져 "다시 시도" 화면이 뜨게 한다
  let stepError = null;
  const tryFetch = url => fetchJson(url, headers).catch(e => {
    stepError ||= e;
    return null;
  });

  const get = new URL('https://lrclib.net/api/get');
  get.searchParams.set('track_name', title);
  get.searchParams.set('artist_name', artist);
  if (album) get.searchParams.set('album_name', album);
  if (durationSec) get.searchParams.set('duration', String(durationSec));
  const exact = fromRecord(await tryFetch(get));
  if (exact) return exact;

  // 정확 매칭 실패 -> 검색 후 길이가 가까운 후보 (싱크 우선)
  const gap = r => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 99);
  const pick = (results, strict) => {
    const candidates = (Array.isArray(results) ? results : [])
      .filter(r => (strict ? gap(r) <= 3 : !durationSec || !r.duration || gap(r) <= 3))
      .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || gap(a) - gap(b));
    for (const c of candidates) {
      const parsed = fromRecord(c);
      if (parsed) return parsed;
    }
    return null;
  };

  // 제목이 같은데 길이만 다른 레코드 (같은 곡의 다른 녹음). 싱크 없이 텍스트만 쓴다
  const baseTitle = cleanTitle(title).toLowerCase();
  const sameTitleTakes = results => (Array.isArray(results) ? results : [])
    .filter(r => cleanTitle(r.trackName || '').toLowerCase() === baseTitle)
    .map(unsynced).filter(Boolean);
  // 다른 아티스트 레코드는 제목 같은 레코드들의 첫 줄이 전부 같을 때만 (= 같은 곡이라는 근거).
  // "I Love You" 처럼 제목만 같은 다른 곡이 섞이면 포기한다
  const firstLine = l => l.lines[0].text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const consensus = takes => (takes.length && takes.every(t => firstLine(t) === firstLine(takes[0])) ? takes[0] : null);

  // 각 단계는 싱크 가사를 찾으면 바로 끝낸다. 싱크 없는 결과는 모아 두고 마지막에 순서대로 고른다
  let plain = null;
  let sameArtistOtherTake = null;
  const firstArtist = artist.split(/,\s*/)[0];
  const search = new URL('https://lrclib.net/api/search');
  search.searchParams.set('track_name', cleanTitle(title));
  search.searchParams.set('artist_name', firstArtist);
  const artistResults = await tryFetch(search);
  const byArtist = pick(artistResults, false);
  if (byArtist?.synced) return byArtist;
  plain = byArtist;
  sameArtistOtherTake = sameTitleTakes(artistResults)[0] || null;

  // 로마자 아티스트명 -> 원어 이름으로 다시 검색
  for (const name of await nativeArtistNames(firstArtist)) {
    search.searchParams.set('artist_name', name);
    const nativeResults = await tryFetch(search);
    const byNative = pick(nativeResults, false);
    if (byNative?.synced) return byNative;
    plain ||= byNative;
    sameArtistOtherTake ||= sameTitleTakes(nativeResults)[0] || null;
  }

  // 그래도 없으면 아티스트 없이 제목만 검색하되, 오매칭 방지로 길이 ±3초 일치 필수
  let titleResults = null;
  if (durationSec) {
    const titleSearch = new URL('https://lrclib.net/api/search');
    titleSearch.searchParams.set('q', cleanTitle(title));
    titleResults = await tryFetch(titleSearch);
    const byTitle = pick(titleResults, true);
    if (byTitle?.synced) return byTitle;
    plain ||= byTitle;
  }

  // 싱크 없는 후보: 길이 맞는 plain -> 같은 아티스트의 다른 녹음 ->
  // 제목에 "(Live)" 같은 버전 표기가 있을 때만 다른 아티스트의 같은 곡 (첫 줄 일치 확인)
  const result = plain || sameArtistOtherTake ||
    (isVersionVariant(title) ? consensus(sameTitleTakes(titleResults)) : null);
  if (!result && stepError) throw stepError;
  return result;
}

async function fetchLyricsOvh({ title, artist }) {
  const data = await fetchJson(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(artist.split(/,\s*/)[0])}/${encodeURIComponent(cleanTitle(title))}`
  );
  if (!data?.lyrics) return null;
  const lines = plainLines(data.lyrics);
  return lines.length ? { lines, synced: false, source: 'lyrics.ovh' } : null;
}

async function fetchLyrics(track) {
  let lrclibError = null;
  try {
    const result = await fetchLrclib(track);
    if (result) return result;
  } catch (e) {
    lrclibError = e; // lrclib 장애여도 다음 소스로 진행
  }
  try {
    const result = await fetchLyricsOvh(track);
    if (result) return result;
  } catch (_) {}
  // "HTTP 503" 같은 내부 메시지는 화면에 내보내지 않는다 (시간 초과는 서비스 워커가 따로 안내)
  if (lrclibError) throw lrclibError.name === 'AbortError' ? lrclibError : new Error(t('errLyricsServer'));
  return null;
}

export { fetchLyrics, parseLrc };

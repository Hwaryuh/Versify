import { learnFromCredits } from './artists.js';
import { fetchJson } from './http.js';
import { ARTIST_EXACT, ARTIST_SOUNDS_LIKE, artistMatch, cleanTitle, plainLines, sameTitle, splitArtists } from './text.js';

const UA = 'SpotifyLyricsTranslator/2.0';

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

function unsynced(rec) {
  if (!rec || rec.instrumental) return null;
  const lines = plainLines(rec.plainLyrics || parseLrc(rec.syncedLyrics || '').map(l => l.text).join('\n'));
  return lines.length ? { lines, synced: false, source: 'lrclib' } : null;
}

async function fetchLrclib({ title, artist, album, durationMs }, known) {
  const headers = { 'Lrclib-Client': UA };
  const durationSec = durationMs ? Math.round(durationMs / 1000) : 0;

  // A failing step does not stop the next one; if nothing is found at the end, throw that error so the "retry" screen appears.
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
  const gap = r => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 99);
  const ours = r => {
    const level = artistMatch(r.artistName, known.names);
    return level === ARTIST_EXACT || (level === ARTIST_SOUNDS_LIKE && gap(r) <= 3);
  };
  const ownRecords = async results => {
    const sameTitled = (Array.isArray(results) ? results : []).filter(r => r && sameTitle(r.trackName, title));
    await learnFromCredits(sameTitled.map(r => r.artistName), known);
    return sameTitled.filter(ours);
  };

  const [exactRecord] = await ownRecords([await tryFetch(get)]);
  const exact = fromRecord(exactRecord);
  if (exact) return exact;

  const pick = async (results, strict) => {
    const candidates = (await ownRecords(results))
      .filter(r => (strict ? gap(r) <= 3 : !durationSec || !r.duration || gap(r) <= 3))
      .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || gap(a) - gap(b));
    for (const c of candidates) {
      const parsed = fromRecord(c);
      if (parsed) return parsed;
    }
    return null;
  };

  // Same title but different duration (another recording of the same song). Use the text without sync.
  const sameTitleTakes = async results => (await ownRecords(results)).map(unsynced).filter(Boolean);

  let plain = null;
  let sameArtistOtherTake = null;
  const firstArtist = splitArtists(artist)[0] || artist;
  const search = new URL('https://lrclib.net/api/search');
  search.searchParams.set('track_name', cleanTitle(title));
  search.searchParams.set('artist_name', firstArtist);
  const artistResults = await tryFetch(search);
  const byArtist = await pick(artistResults, false);
  if (byArtist?.synced) return byArtist;
  plain = byArtist;
  sameArtistOtherTake = (await sameTitleTakes(artistResults))[0] || null;

  for (const name of known.searchNames) {
    search.searchParams.set('artist_name', name);
    const nativeResults = await tryFetch(search);
    const byNative = await pick(nativeResults, false);
    if (byNative?.synced) return byNative;
    plain ||= byNative;
    sameArtistOtherTake ||= (await sameTitleTakes(nativeResults))[0] || null;
  }

  if (durationSec) {
    const titleSearch = new URL('https://lrclib.net/api/search');
    titleSearch.searchParams.set('q', cleanTitle(title));
    const titleResults = await tryFetch(titleSearch);
    const byTitle = await pick(titleResults, true);
    if (byTitle?.synced) return byTitle;
    plain ||= byTitle;
    sameArtistOtherTake ||= (await sameTitleTakes(titleResults))[0] || null;
  }

  // Unsynced candidates: duration-matching plain -> another recording by the same artist.
  const result = plain || sameArtistOtherTake;
  if (!result && stepError) throw stepError;
  return result;
}

export { fetchLrclib, parseLrc };

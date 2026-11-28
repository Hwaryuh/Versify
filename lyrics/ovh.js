import { fetchJson } from './http.js';
import { cleanTitle, plainLines, splitArtists } from './text.js';

async function fetchLyricsOvh({ title, artist }) {
  const data = await fetchJson(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(splitArtists(artist)[0] || artist)}/${encodeURIComponent(cleanTitle(title))}`
  );
  if (!data?.lyrics) return null;
  const lines = plainLines(data.lyrics);
  return lines.length ? { lines, synced: false, source: 'lyrics.ovh' } : null;
}

export { fetchLyricsOvh };

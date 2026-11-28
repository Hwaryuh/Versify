import { t } from '../i18n.js';
import { knownArtists } from './artists.js';
import { fetchBugs } from './bugs.js';
import { fetchLrclib } from './lrclib.js';
import { fetchLyricsOvh } from './ovh.js';

async function fetchLyrics(track) {
  const known = await knownArtists(track.artist);
  if (!known.names.length) return null;
  let lrclibError = null;
  let lrclib = null;
  try {
    lrclib = await fetchLrclib(track, known);
    if (lrclib?.synced) return lrclib;
  } catch (e) {
    lrclibError = e;
  }
  const bugs = await fetchBugs(track, known).catch(() => null);
  if (bugs?.synced) return bugs;
  if (lrclib || bugs) return lrclib || bugs;
  try {
    const result = await fetchLyricsOvh(track);
    if (result) return result;
  } catch (_) {}
  if (lrclibError) throw lrclibError.name === 'AbortError' ? lrclibError : new Error(t('errLyricsServer'));
  return null;
}

export { fetchLyrics };

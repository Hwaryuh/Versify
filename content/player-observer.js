// Reads Spotify Web Player state (isolated world).
// - Track: navigator.mediaSession.metadata
// - Position/duration: the progress bar range input (value = position ms, max = duration ms). There is no <audio> element in the DOM.
// - Spotify's own lyrics: content/page-hook.js passes them over via postMessage.

const SLT = (window.SLT = window.SLT || {});

const spotifyLyrics = new Map();
let currentTrackKey = null;

function progressInput() {
  return document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
}

function artworkHash(url) {
  const m = /\/image\/([0-9a-f]{40})/.exec(url || '');
  return m ? m[1].slice(-24) : null;
}

// Free-account audio ad: the mediaSession title is "Advertisement" (localized to the UI language), artist and album are empty,
// the widget link has data-context-item-type="ad", and the playback controls get ad-controls.
SLT.isAd = function () {
  return !!document.querySelector('[data-testid^="now-playing-widget"] [data-context-item-type="ad"], [data-testid="ad-controls"]');
};

SLT.getTrack = function () {
  const meta = navigator.mediaSession?.metadata;
  if (!meta?.title || SLT.isAd()) return null;
  const max = parseInt(progressInput()?.max, 10);
  return {
    title: meta.title,
    artist: meta.artist || '',
    album: meta.album || '',
    durationMs: max > 0 ? max : 0,
    artworkHash: artworkHash(meta.artwork?.[meta.artwork.length - 1]?.src)
  };
};

// The range value may update only about once a second, so interpolate by adding the time elapsed since the value last changed.
// Every second Spotify sets the value attribute to "current position + 1s" and animates the bar to it over 1s
// (--progress-bar-duration=1000ms on the inner div). Even while paused it is +1s.
// So the real position = value - lookahead + (time since the last update, capped at lookahead).
let lastValue = -1;
let lastChangeAt = 0;
let observedInput = null;
const valueObserver = new MutationObserver(() => {
  lastValue = readValue(observedInput);
  lastChangeAt = performance.now();
});

function readValue(input) {
  // .value is rounded to step (5000), so read the value attribute that React keeps in sync (exact ms).
  return Math.round(parseFloat(input.getAttribute('value') ?? input.value)) || 0;
}

function lookaheadMs(input) {
  const holder = input.closest('[data-testid="playback-progressbar"]')?.querySelector('[style*="--progress-bar-duration"]');
  const ms = parseFloat(holder?.style.getPropertyValue('--progress-bar-duration'));
  return Number.isFinite(ms) && ms >= 0 && ms <= 5000 ? ms : 0;
}

SLT.getPositionMs = function () {
  const input = progressInput();
  if (!input) return null;
  if (input !== observedInput) {
    valueObserver.disconnect();
    valueObserver.observe(input, { attributes: true, attributeFilter: ['value'] });
    observedInput = input;
    lastValue = readValue(input);
    lastChangeAt = performance.now();
  }
  const ahead = lookaheadMs(input);
  const elapsed = performance.now() - lastChangeAt;
  // If the value stays unchanged for more than 1.5x the update interval (= lookahead), treat playback as stopped.
  const playing = ahead > 0 ? elapsed < ahead * 1.5 : elapsed < 1500;
  const base = lastValue - ahead;
  let pos = Math.max(0, playing ? base + Math.min(elapsed, ahead || 1000) : base);
  // Ignore small backward jumps (<1.5s) from update jitter during playback, so the highlight does not flicker back to the previous line.
  // Larger backward jumps are user seeks, so follow them.
  if (playing && pos < lastReturned && lastReturned - pos < 1500) pos = lastReturned;
  lastReturned = pos;
  return pos;
};
let lastReturned = 0;

SLT.seek = function (ms) {
  const input = progressInput();
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const step = input.getAttribute('step');
  input.step = 'any'; // with step=5000 the value is rounded to 5-second units
  setter.call(input, String(Math.max(0, Math.round(ms))));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (step !== null) input.setAttribute('step', step);
  lastValue = -1;
  return true;
};

// Fallback: match by album art only when page-hook cannot read the current trackId. To avoid mismatches:
// - exactly one candidate with the same art (give up if it cannot be told apart from the next track of the same album, prefetched)
// - only responses received after the track changed (never attach the previous track's lyrics to the new one)
// - the last line's time is within the track duration
// - lyrics already used for another track (trackId) are not reused. Unsynced lyrics have all line times at 0, so the duration check cannot filter them.
// If a condition fails, return null -> the service worker falls back to LRCLIB.
let trackStartedAt = 0;
const usedFor = new Map();

const trackKey = (t) => `${t.title}\u0000${t.artist}\u0000${t.album}`;

// The current trackId that page-hook.js read from React props. '' when it cannot be read (e.g. Spotify changed its structure).
function currentTrackId() {
  delete document.documentElement.dataset.sltTrackId;
  window.dispatchEvent(new CustomEvent('slt-read-track'));
  return document.documentElement.dataset.sltTrackId || '';
}

SLT.findSpotifyLyrics = function (track) {
  if (!track) return null;
  // If trackId is known, use only that. Picking by album art would attach the lyrics of the next track of the same album (prefetch).
  const key = trackKey(track);
  const id = currentTrackId();
  if (id) {
    // Right after a track change the widget may still show the previous track: drop a trackId already used for another track.
    const entry = spotifyLyrics.get(id);
    if (!entry || (usedFor.get(id) ?? key) !== key) return null;
    usedFor.set(id, key);
    return entry;
  }
  if (!track.artworkHash) return null;
  const matches = [...spotifyLyrics.values()].filter(e =>
    e.artworkHash === track.artworkHash &&
    e.capturedAt >= trackStartedAt - 1000 &&
    (usedFor.get(e.trackId) ?? key) === key &&
    (!track.durationMs || (e.lines.at(-1)?.startTimeMs ?? 0) < track.durationMs));
  if (matches.length !== 1) return null;
  usedFor.set(matches[0].trackId, key);
  if (usedFor.size > 50) usedFor.delete(usedFor.keys().next().value);
  return matches[0];
};

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'slt-hook' || e.data.type !== 'SPOTIFY_LYRICS') return;
  const entry = e.data.entry;
  if (typeof entry?.trackId !== 'string' || !Array.isArray(entry.lines)) return;
  spotifyLyrics.set(entry.trackId, entry);
  if (spotifyLyrics.size > 20) spotifyLyrics.delete(spotifyLyrics.keys().next().value);
});
window.postMessage({ source: 'slt-iso', type: 'REPLAY' }, location.origin);

const AD_KEY = '\u0000ad';

function checkCurrentTrack() {
  if (SLT.isAd()) {
    if (currentTrackKey === AD_KEY) return;
    currentTrackKey = AD_KEY; // after an ad, trackChanged fires again even if the same track resumes
    window.dispatchEvent(new CustomEvent('adPlaying'));
    return;
  }
  const track = SLT.getTrack();
  if (!track) return;
  const key = trackKey(track);
  if (key === currentTrackKey) return;
  if (currentTrackKey !== null) trackStartedAt = Date.now();
  currentTrackKey = key;
  window.dispatchEvent(new CustomEvent('trackChanged', { detail: track }));
}

SLT.checkTrack = checkCurrentTrack; // panel.js makes the first check after registering its listeners
setInterval(checkCurrentTrack, 1000);

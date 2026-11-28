// MAIN world, document_start.
// Eavesdrops on the color-lyrics response the Spotify web player already fetches and forwards it to the isolated world.
// Never handles tokens or issues requests: it only reads a clone of a response the page already received.
(() => {
  const LYRICS_RE = /\/color-lyrics\/v2\/track\/([A-Za-z0-9]{22})(?:\/image\/([^/?]+))?/;
  const MAX_BUFFER = 20;
  const buffer = [];

  function artworkHash(url) {
    const m = /\/image\/([0-9a-f]{40})/.exec(url || '');
    return m ? m[1].slice(-24) : null;
  }

  function post(entry) {
    window.postMessage({ source: 'slt-hook', type: 'SPOTIFY_LYRICS', entry }, location.origin);
  }

  function capture(url, json) {
    const m = LYRICS_RE.exec(url);
    const lyrics = json?.lyrics;
    if (!m || !Array.isArray(lyrics?.lines)) return;

    const entry = {
      trackId: m[1],
      artworkHash: m[2] ? artworkHash(decodeURIComponent(m[2])) : null,
      syncType: String(lyrics.syncType || ''),
      language: String(lyrics.language || ''),
      lines: lyrics.lines.slice(0, 500).map(l => ({
        startTimeMs: parseInt(l.startTimeMs, 10) || 0,
        text: String(l.words ?? '').slice(0, 500)
      })),
      capturedAt: Date.now()
    };

    const i = buffer.findIndex(e => e.trackId === entry.trackId);
    if (i >= 0) buffer.splice(i, 1);
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    post(entry);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = nativeFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    if (url && LYRICS_RE.test(url)) {
      promise
        .then(res => (res.ok ? res.clone().json() : null))
        .then(json => json && capture(url, json))
        .catch(() => {});
    }
    return promise;
  };

  // The current trackId is not in a DOM attribute; it only exists in the React props (uri) of the now-playing widget.
  // The isolated world cannot read React internals, so on a request event this writes it to an html attribute.
  // CustomEvent dispatch is synchronous, so the isolated world can read the attribute right after dispatching.
  function currentTrackId() {
    const widget = document.querySelector('[data-testid^="now-playing-widget"]');
    const link = widget?.querySelector('a[href*="/album/"], a[href*="/track/"]');
    const key = link && Object.keys(link).find(k => k.startsWith('__reactFiber$'));
    // Look only inside the widget (link -> widget): going outside can pick up another track's uri.
    for (let f = key && link[key], i = 0; f && i < 40; f = f.return, i++) {
      const uri = f.memoizedProps?.uri;
      if (typeof uri === 'string' && /^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) return uri.slice(14);
      if (f.stateNode === widget) break;
    }
    return '';
  }
  window.addEventListener('slt-read-track', () => {
    try {
      document.documentElement.dataset.sltTrackId = currentTrackId();
    } catch (_) {
      document.documentElement.dataset.sltTrackId = '';
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'slt-iso' || e.data.type !== 'REPLAY') return;
    buffer.forEach(post);
  });
})();

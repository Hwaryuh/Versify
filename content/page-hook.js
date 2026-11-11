// MAIN world, document_start.
// Spotify 웹 플레이어가 직접 받아오는 color-lyrics 응답을 엿들어 isolated world로 넘긴다.
// 토큰을 다루거나 요청을 새로 만들지 않는다 - 페이지가 이미 받은 응답만 복제해서 읽는다.
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

  // 현재 곡 trackId 는 DOM 속성에 없고 now-playing 위젯의 React props(uri)에만 있다 (실측 2026-10).
  // isolated world 는 React 내부 값을 못 읽으므로, 요청 이벤트를 받으면 html 속성에 써 준다.
  // CustomEvent 는 동기로 전달돼서 isolated world 가 dispatch 직후 바로 읽을 수 있다.
  function currentTrackId() {
    const widget = document.querySelector('[data-testid^="now-playing-widget"]');
    const link = widget?.querySelector('a[href*="/album/"], a[href*="/track/"]');
    const key = link && Object.keys(link).find(k => k.startsWith('__reactFiber$'));
    // 위젯 안쪽(링크 -> 위젯 사이)만 본다: 바깥으로 나가면 다른 곡 uri 를 집을 수 있다
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

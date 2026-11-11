// Spotify Web Player 상태 읽기 (isolated world).
// - 트랙: navigator.mediaSession.metadata
// - 재생 위치/길이: 재생바 range input (value = 위치 ms, max = 길이 ms). <audio> 요소는 DOM에 없다.
// - Spotify 자체 가사: content/page-hook.js 가 postMessage 로 넘겨준다.

const SLT = (window.SLT = window.SLT || {});

const spotifyLyrics = new Map(); // trackId -> entry
let currentTrackKey = null;

function progressInput() {
  return document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
}

function artworkHash(url) {
  const m = /\/image\/([0-9a-f]{40})/.exec(url || '');
  return m ? m[1].slice(-24) : null;
}

// 무료 계정 오디오 광고: mediaSession 제목이 "광고"(UI 언어로 현지화), 아티스트·앨범은 비어 있고
// 위젯 링크에 data-context-item-type="ad", 재생 컨트롤에 ad-controls 가 붙는다 (실측 2026-10)
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

// range 값은 ~1초 간격으로만 갱신될 수 있어서, 값이 바뀐 시점부터 흐른 시간을 더해 보간한다.
// 실측(2026-10): Spotify는 1초마다 value 속성에 "현재 위치 + 1초"를 넣고, 재생바를 1초 동안 애니메이션으로 따라가게 한다
// (재생바 안쪽 div의 --progress-bar-duration=1000ms). 일시정지 중에도 +1초다.
// 그래서 실제 위치 = value - lookahead + (마지막 갱신 뒤 흐른 시간, lookahead 까지).
let lastValue = -1;
let lastChangeAt = 0;
let observedInput = null;
const valueObserver = new MutationObserver(() => {
  lastValue = readValue(observedInput);
  lastChangeAt = performance.now(); // 갱신 순간을 정확히 기록 (폴링 주기만큼 늦지 않게)
});

function readValue(input) {
  // .value 는 step(5000) 단위로 반올림되므로 React가 동기화하는 value 속성(정확한 ms)을 읽는다
  return Math.round(parseFloat(input.getAttribute('value') ?? input.value)) || 0;
}

function lookaheadMs(input) {
  const holder = input.closest('[data-testid="playback-progressbar"]')?.querySelector('[style*="--progress-bar-duration"]');
  const ms = parseFloat(holder?.style.getPropertyValue('--progress-bar-duration'));
  return Number.isFinite(ms) && ms >= 0 && ms <= 5000 ? ms : 0; // 변수가 없어지면 보정하지 않는다
}

SLT.getPositionMs = function () {
  const input = progressInput();
  if (!input) return null;
  if (input !== observedInput) {
    // React가 재생바를 새로 만들면 다시 붙인다
    valueObserver.disconnect();
    valueObserver.observe(input, { attributes: true, attributeFilter: ['value'] });
    observedInput = input;
    lastValue = readValue(input);
    lastChangeAt = performance.now();
  }
  const ahead = lookaheadMs(input);
  const elapsed = performance.now() - lastChangeAt;
  // 갱신 주기(=lookahead)의 1.5배가 넘도록 값이 그대로면 멈춘 것으로 본다
  const playing = ahead > 0 ? elapsed < ahead * 1.5 : elapsed < 1500;
  const base = lastValue - ahead;
  let pos = Math.max(0, playing ? base + Math.min(elapsed, ahead || 1000) : base);
  // 재생 중 갱신 지터로 생기는 작은 역행(<1.5초)은 무시 - 강조가 직전 줄로 깜빡 되돌아가지 않게.
  // 그보다 큰 역행은 사용자가 탐색한 것이므로 따른다.
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
  input.step = 'any'; // step=5000 그대로면 값이 5초 단위로 반올림됨
  setter.call(input, String(Math.max(0, Math.round(ms))));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (step !== null) input.setAttribute('step', step);
  lastValue = -1;
  return true;
};

// 대체 경로: page-hook 이 현재 곡 trackId 를 못 읽을 때만 앨범 아트로 맞춘다. 오매칭을 피하려고:
// - 아트가 같은 후보가 정확히 하나 (같은 앨범 다음 곡 prefetch와 구분 불가하면 포기)
// - 곡이 바뀐 뒤에 받은 응답만 (직전 곡 가사를 새 곡에 붙이지 않게)
// - 마지막 줄 시각이 곡 길이 안쪽
// - 이미 다른 곡에 쓴 가사(trackId)는 다시 쓰지 않음. 싱크 없는 가사는 줄 시각이 전부 0이라
//   길이 검사로 못 거르고, 이전 곡 가사가 새 곡 이름으로 번역·캐시되던 버그가 있었다.
// 조건이 안 맞으면 null -> 서비스 워커가 LRCLIB로 넘어간다.
let trackStartedAt = 0;
const usedFor = new Map(); // trackId -> 그 가사를 붙인 곡 키

const trackKey = (t) => `${t.title}\u0000${t.artist}\u0000${t.album}`;

// page-hook.js 가 React props 에서 읽어 준 현재 곡 trackId. 못 읽으면 '' (Spotify 구조 변경 등)
function currentTrackId() {
  delete document.documentElement.dataset.sltTrackId;
  window.dispatchEvent(new CustomEvent('slt-read-track'));
  return document.documentElement.dataset.sltTrackId || '';
}

SLT.findSpotifyLyrics = function (track) {
  if (!track) return null;
  // trackId 를 알면 그것만 쓴다. 앨범 아트로 고르면 같은 앨범 다음 곡(prefetch) 가사가 붙는다
  // (실측: 현재 곡에 Spotify 가사가 없으면 다음 곡 가사만 요청돼서 후보가 하나로 보임)
  const key = trackKey(track);
  const id = currentTrackId();
  if (id) {
    // 곡 전환 직후엔 위젯이 아직 이전 곡일 수 있다: 다른 곡에 이미 쓴 trackId 면 버린다
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
    currentTrackKey = AD_KEY; // 광고 뒤엔 같은 곡이 이어져도 trackChanged 가 다시 뜬다
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

SLT.checkTrack = checkCurrentTrack; // 첫 검사는 panel.js 가 리스너 등록 후 호출
setInterval(checkCurrentTrack, 1000);

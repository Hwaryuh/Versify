import { fetchLyrics } from '../lyrics/lrclib.js';
import { translateLines as deepl } from '../translate/deepl.js';
import { translateLines as claude } from '../translate/claude.js';
import { isTranslatable, hasScriptCheck } from '../translate/style.js';
import { t } from '../i18n.js';

const CACHE_VERSION = 'v2';
const DEFAULTS = {
  engine: 'deepl',
  claudeModel: 'claude-opus-5-5',
  targetLang: 'KO',
  register: 'casual',
  autoTranslate: true,
  preferSpotify: true
};

// API 키는 기기 간 동기화되지 않도록 storage.local 에 둔다. (v1은 sync 에 저장했으므로 한 번 옮김)
async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get({ ...DEFAULTS, deeplApiKey: '' }),
    chrome.storage.local.get({ deeplApiKey: '', claudeApiKey: '' })
  ]);
  if (!local.deeplApiKey && sync.deeplApiKey) {
    local.deeplApiKey = sync.deeplApiKey;
    await chrome.storage.local.set({ deeplApiKey: sync.deeplApiKey });
    await chrome.storage.sync.remove('deeplApiKey');
  }
  delete sync.deeplApiKey;
  return { ...sync, ...local };
}

function isSyncedSpotify(entry) {
  return /SYNCED/.test(entry?.syncType || '') && !/UNSYNCED/.test(entry.syncType);
}

function toLyrics(entry) {
  return { lines: entry.lines, synced: isSyncedSpotify(entry), source: 'spotify', language: entry.language };
}

async function resolveLyrics(track, spotify, preferSpotify) {
  if (spotify?.lines?.length && preferSpotify && isSyncedSpotify(spotify)) return toLyrics(spotify);
  const fromWeb = await fetchLyrics(track).catch(e => (spotify?.lines?.length ? null : Promise.reject(e)));
  if (fromWeb?.synced || !spotify?.lines?.length) return fromWeb;
  return toLyrics(spotify);
}

const inFlight = new Map();
const recentCalls = new Map(); // tabId -> 번역 API 호출 시각들

// 페이지(open.spotify.com)에서 온 값은 신뢰하지 않는다: 타입·길이 제한해서 새 객체로 만든다
function str(v, max = 300) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function sanitizeTrack(t) {
  return { title: str(t?.title), artist: str(t?.artist), album: str(t?.album), durationMs: Number(t?.durationMs) > 0 ? Number(t.durationMs) : 0 };
}

function sanitizeSpotify(e) {
  if (!Array.isArray(e?.lines) || !e.lines.length) return null;
  return {
    syncType: str(e.syncType, 40),
    language: str(e.language, 10),
    lines: e.lines.slice(0, 400).map(l => ({ startTimeMs: Number.isFinite(l?.startTimeMs) ? Math.max(0, l.startTimeMs) : 0, text: str(l?.text) }))
  };
}

// ponytail: 탭당 10분에 20곡까지. 페이지 스크립트가 버튼을 연타해도 키 사용량이 터지지 않게 하는 상한.
function allowTranslation(tabId) {
  const now = Date.now();
  const calls = (recentCalls.get(tabId) || []).filter(t => now - t < 10 * 60 * 1000);
  if (calls.length >= 20) return false;
  calls.push(now);
  recentCalls.set(tabId, calls);
  return true;
}

async function handle({ track, spotify, force }, tabId, settings) {
  const engine = settings.engine === 'claude' ? 'claude' : 'deepl';
  const apiKey = engine === 'claude' ? settings.claudeApiKey : settings.deeplApiKey;
  if (!apiKey) return { error: 'NO_KEY', engine };

  const cacheKey = [CACHE_VERSION, settings.targetLang, engine, engine === 'claude' ? settings.claudeModel : '',
    settings.register, track.title, track.artist, track.album].join('|');

  const translate = (lines) => (engine === 'claude' ? claude : deepl)(lines, {
    targetLang: settings.targetLang,
    register: settings.register,
    apiKey,
    model: settings.claudeModel
  });

  if (!force) {
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    const betterSourceNow = cached && !cached.synced && isSyncedSpotify(spotify) && settings.preferSpotify;
    // 줄 단위 판별 전 캐시는 Spotify 언어가 같으면 곡 전체를 건너뛰었다 -> 번역이 빠진 줄이 있으면 다시 만든다
    const missingLines = cached && hasScriptCheck(settings.targetLang) &&
      cached.lines.some(l => !l.translated && isTranslatable(l.text, settings.targetLang));
    if (cached && !betterSourceNow && !missingLines) {
      // v2.0 캐시에는 제목 번역이 없다 -> 제목만 한 번 번역해서 채워 둔다
      if (cached.titleTranslated === undefined) {
        cached.titleTranslated = (await translate([{ startTimeMs: 0, text: track.title }]).catch(() => null))?.translations[0] ?? '';
        await chrome.storage.local.set({ [cacheKey]: cached });
      }
      return { ...cached, cached: true };
    }
  }

  const progress = (stage, extra) =>
    chrome.tabs.sendMessage(tabId, { type: 'LYRICS_PROGRESS', title: track.title, artist: track.artist, album: track.album, stage, ...extra })
      .catch(() => {});

  progress('lyrics');
  const lyrics = await resolveLyrics(track, spotify, settings.preferSpotify);
  if (!lyrics) return { error: 'NO_LYRICS' };

  // 제목은 마지막 한 줄로 같이 보낸다 (요청 하나로 끝내고, 후렴과 같은 제목이면 같은 번역이 나옴)
  const toSend = [...lyrics.lines, { startTimeMs: 0, text: track.title }];
  // KO/JA 는 줄마다 문자로 판별한다 (섞인 영어 줄은 번역). 판별 못 하는 언어만 Spotify 언어로 곡 전체를 건너뜀
  const sameLang = !hasScriptCheck(settings.targetLang) &&
    !!lyrics.language && lyrics.language.toUpperCase() === settings.targetLang.split('-')[0];
  const needsTranslation = !sameLang && toSend.some(l => isTranslatable(l.text, settings.targetLang));
  if (needsTranslation && !allowTranslation(tabId)) return { error: t('errTooManyRequests') };

  progress('translate', { lines: lyrics.lines, synced: lyrics.synced, source: lyrics.source });

  const { translations, complete } = needsTranslation
    ? await translate(toSend)
    : { translations: toSend.map(() => ''), complete: true };
  const titleTranslated = translations[lyrics.lines.length] || '';

  const result = {
    lines: lyrics.lines.map((l, i) => ({ ...l, translated: translations[i] || '' })),
    synced: lyrics.synced,
    source: lyrics.source,
    language: lyrics.language || '',
    engine,
    partial: !complete,
    titleTranslated
  };
  if (complete) await chrome.storage.local.set({ [cacheKey]: result });
  return result;
}

async function dispatch(msg, tabId) {
  const settings = await getSettings();
  const req = { track: sanitizeTrack(msg.track), spotify: sanitizeSpotify(msg.spotify), force: !!msg.force };
  if (!req.track.title) return { error: t('errNoTrack') };

  // 같은 요청(자동 번역 + 버튼 연타)은 하나로 합친다. 설정·가사 입력·API 키가 다르면 별개 작업.
  // (키를 바꾼 직후 재번역이 이전 키로 도는 작업에 합쳐지지 않게. 메모리 안의 Map 키라 밖으로 나가지 않음)
  const key = JSON.stringify([tabId, req.track, req.force, req.spotify,
    settings.engine, settings.claudeModel, settings.targetLang, settings.register, settings.preferSpotify,
    settings.engine === 'claude' ? settings.claudeApiKey : settings.deeplApiKey]);
  let job = inFlight.get(key);
  if (!job) {
    job = handle(req, tabId, settings).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg?.type !== 'FETCH_LYRICS' || !sender.tab) return;
  dispatch(msg, sender.tab.id)
    .then(result => sendResponse(result))
    .catch(e => sendResponse({ error: e.name === 'AbortError' ? t('errTimeout') : e.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => recentCalls.delete(tabId));

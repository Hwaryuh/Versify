import { fetchLyrics } from '../lyrics/index.js';
import { translateLines as deepl } from '../translate/deepl.js';
import { translateLines as claude } from '../translate/claude.js';
import { isTranslatable, hasScriptCheck } from '../translate/style.js';
import { t } from '../i18n.js';

// Per-engine translation scheme version. Bumping an engine retranslates only that engine's cache.
const CACHE_VERSION = { deepl: 'v3', claude: 'v2' };
const DEFAULTS = {
  engine: 'deepl',
  claudeModel: 'claude-opus-5-5',
  targetLang: 'KO',
  register: 'casual',
  autoTranslate: true,
  preferSpotify: true
};

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
const recentCalls = new Map();

// Values from the page (open.spotify.com) are untrusted: copy them into a new object with type and length limits.
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

  const cacheKey = [CACHE_VERSION[engine], settings.targetLang, engine, engine === 'claude' ? settings.claudeModel : '',
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
    const missingLines = cached && hasScriptCheck(settings.targetLang) &&
      cached.lines.some(l => !l.translated && isTranslatable(l.text, settings.targetLang));
    if (cached && !betterSourceNow && !missingLines) {
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

  // The title goes out as the last line of the same request. standalone: never merged into one sentence with the last verse.
  const toSend = [...lyrics.lines, { startTimeMs: 0, text: track.title, standalone: true }];
  // KO/JA are checked per line by script (mixed English lines get translated). Only languages without a script check skip the whole song by Spotify language.
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

  // Identical requests share one job. Different settings, lyrics input, or API key make separate jobs.
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

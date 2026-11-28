// Options page: changes are saved immediately.
const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });

const SYNC_DEFAULTS = {
  engine: 'deepl',
  claudeModel: 'claude-opus-5-5',
  targetLang: 'KO',
  register: 'casual',
  autoTranslate: true,
  preferSpotify: true
};
const HINTS = { deepl: t('hintDeepl'), claude: t('hintClaude') };

function cleanKey(value) {
  return value.replace(/[​-‍⁠﻿]/g, '').trim();
}

const savedTimers = new WeakMap();
function flashSaved(control, text = t('savedShort')) {
  const badge = control.closest('section').querySelector('.saved');
  badge.textContent = text;
  badge.classList.add('show');
  clearTimeout(savedTimers.get(badge));
  savedTimers.set(badge, setTimeout(() => badge.classList.remove('show'), 1500));
}

function showEngine(engine) {
  $('deepl-fields').hidden = engine !== 'deepl';
  $('claude-fields').hidden = engine !== 'claude';
  $('engine-hint').textContent = HINTS[engine];
}

Promise.all([
  chrome.storage.sync.get({ ...SYNC_DEFAULTS, deeplApiKey: '' }),
  chrome.storage.local.get({ deeplApiKey: '', claudeApiKey: '' })
]).then(([s, l]) => {
  s.engine = s.engine === 'claude' ? 'claude' : 'deepl';
  $(`engine-${s.engine}`).checked = true;
  $(`reg-${s.register === 'polite' ? 'polite' : 'casual'}`).checked = true;
  $('deeplKey').value = l.deeplApiKey || s.deeplApiKey;
  $('claudeKey').value = l.claudeApiKey;
  $('claudeModel').value = s.claudeModel;
  $('targetLang').value = s.targetLang;
  $('autoTranslate').checked = s.autoTranslate;
  $('preferSpotify').checked = s.preferSpotify;
  showEngine(s.engine);
});

const syncFields = [
  ['input[name="engine"]', 'engine', el => el.value],
  ['input[name="register"]', 'register', el => el.value],
  ['#claudeModel', 'claudeModel', el => el.value],
  ['#targetLang', 'targetLang', el => el.value],
  ['#autoTranslate', 'autoTranslate', el => el.checked],
  ['#preferSpotify', 'preferSpotify', el => el.checked]
];
for (const [selector, key, read] of syncFields) {
  document.querySelectorAll(selector).forEach(el => el.addEventListener('change', async () => {
    if (key === 'engine') showEngine(el.value);
    await chrome.storage.sync.set({ [key]: read(el) });
    flashSaved(el);
  }));
}

// API key: not saved while typing (so no request goes out with a half-typed key). change = when focus leaves.
for (const [id, key] of [['deeplKey', 'deeplApiKey'], ['claudeKey', 'claudeApiKey']]) {
  const input = $(id);
  const error = $(`${id}-error`);
  input.addEventListener('change', async () => {
    const value = cleanKey(input.value);
    const bad = value && !/^[\x21-\x7E]+$/.test(value);
    input.setAttribute('aria-invalid', String(!!bad));
    error.hidden = !bad;
    error.textContent = bad ? t('keyBadChars') : '';
    if (bad) return;
    input.value = value;
    await chrome.storage.local.set({ [key]: value });
    if (key === 'deeplApiKey') await chrome.storage.sync.remove('deeplApiKey');
    flashSaved(input);
  });
}

// Translation cache: the service worker stores it under per-engine version keys ('v3|...').
const isCacheKey = (k) => /^v\d+\|/.test(k) || k.startsWith('lyrics::');

async function cacheKeys() {
  return Object.keys(await chrome.storage.local.get(null)).filter(isCacheKey);
}

async function refreshCacheInfo() {
  const keys = await cacheKeys();
  const bytes = keys.length ? await chrome.storage.local.getBytesInUse(keys) : 0;
  const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  $('cache-info').textContent = keys.length ? t('cacheInfo', keys.length, size) : t('cacheEmpty');
  $('cache-clear').disabled = !keys.length;
}

let confirmTimer = null;
$('cache-clear').addEventListener('click', async () => {
  const btn = $('cache-clear');
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = t('cacheConfirm');
    confirmTimer = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = t('cacheClear'); }, 5000);
    return;
  }
  clearTimeout(confirmTimer);
  btn.classList.remove('confirm');
  btn.textContent = t('cacheClear');
  await chrome.storage.local.remove(await cacheKeys());
  await refreshCacheInfo();
  flashSaved(btn, t('cacheCleared'));
});

refreshCacheInfo();

// 옵션 페이지: 바꾸는 즉시 저장한다 (Chrome 옵션 관례. 닫을 때 잃어버리지 않게)
const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key; // 문구: _locales/*/messages.json
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

// 바꾼 컨트롤이 속한 섹션 제목 옆에 "저장됨"을 잠깐 보여준다
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
  $('deeplKey').value = l.deeplApiKey || s.deeplApiKey; // v1은 sync 에 저장했음
  $('claudeKey').value = l.claudeApiKey;
  $('claudeModel').value = s.claudeModel;
  $('targetLang').value = s.targetLang;
  $('autoTranslate').checked = s.autoTranslate;
  $('preferSpotify').checked = s.preferSpotify;
  showEngine(s.engine);
});

// 일반 설정: 바뀐 항목 하나만 sync 에 쓴다
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

// API 키: 입력 중에는 저장하지 않는다 (반쪽 키로 번역 요청이 나가지 않게). change = 포커스가 빠질 때
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

// ── 번역 캐시 (서비스 워커가 'v2|...', 'v3|...' 처럼 엔진별 버전 키로 저장. 'lyrics::' 는 v1 캐시) ──
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
  // 실수로 지우지 않게 두 번 눌러야 삭제 (화면 낭독기 사용자도 따라올 수 있게 5초)
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = t('cacheConfirm');
    confirmTimer = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = t('cacheClear'); }, 5000);
    return;
  }
  clearTimeout(confirmTimer);
  btn.classList.remove('confirm');
  btn.textContent = t('cacheClear');
  await chrome.storage.local.remove(await cacheKeys()); // API 키·패널 위치는 그대로
  await refreshCacheInfo();
  flashSaved(btn, t('cacheCleared'));
});

refreshCacheInfo();

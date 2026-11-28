// Toolbar popup: current engine status, auto-translate on/off, open the panel.
const $ = (id) => document.getElementById(id);
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
document.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.dataset.i18n); });
document.querySelectorAll('[data-i18n-label]').forEach(n => {
  n.setAttribute('aria-label', t(n.dataset.i18nLabel));
  n.title = t(n.dataset.i18nLabel);
});

const ENGINE_NAMES = { deepl: 'DeepL', claude: 'Claude' };

function setStatus(text) {
  $('status').textContent = text;
}

function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

Promise.all([
  chrome.storage.sync.get({ engine: 'deepl', autoTranslate: true, deeplApiKey: '' }),
  chrome.storage.local.get({ deeplApiKey: '', claudeApiKey: '' })
]).then(([s, l]) => {
  const engine = s.engine === 'claude' ? 'claude' : 'deepl';
  const hasKey = engine === 'claude' ? !!l.claudeApiKey : !!(l.deeplApiKey || s.deeplApiKey);
  $('engine-ready').hidden = !hasKey;
  $('engine-missing').hidden = hasKey;
  $('engine-text').textContent = t('engineKeyReady', ENGINE_NAMES[engine]);
  $('autoTranslate').checked = s.autoTranslate;
});

$('autoTranslate').addEventListener('change', (e) => chrome.storage.sync.set({ autoTranslate: e.target.checked }));
$('open-settings').addEventListener('click', openSettings);
$('add-key').addEventListener('click', openSettings);

$('show-panel').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://open.spotify.com/')) {
    return setStatus(t('needSpotifyTab'));
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' });
    window.close();
  } catch (_) {
    setStatus(t('reloadSpotifyTab'));
  }
});

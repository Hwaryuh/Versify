// Inserts the translation under each line of Spotify's own lyrics view ([data-testid="lyrics-line"]).
// panel.js passes the translations via the 'sltTranslations' event. Lines are matched by source text, so the lyrics origin does not matter.
(() => {
  const CLS = 'slt-native-tr';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let map = new Map();
  let lang = '';
  let scheduled = false;

  function lineText(line) {
    let text = '';
    for (const child of line.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.classList.contains(CLS)) continue;
      text += child.textContent;
    }
    return norm(text);
  }

  function apply() {
    scheduled = false;
    for (const line of document.querySelectorAll('[data-testid="lyrics-line"]')) {
      const existing = line.querySelector(`:scope > .${CLS}`);
      const translated = map.get(lineText(line)) || '';
      if (!translated) {
        existing?.remove();
        continue;
      }
      if (existing?.textContent === translated) continue;
      const node = existing || document.createElement('div');
      node.className = CLS;
      if (lang) node.lang = lang;
      node.textContent = translated;
      if (!existing) line.append(node);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(apply);
  }

  window.addEventListener('sltTranslations', (e) => {
    map = new Map();
    lang = e.detail?.lang || '';
    for (const l of e.detail?.lines || []) {
      const key = norm(l.text);
      const tr = (l.translated || '').trim();
      if (key && tr && norm(tr) !== key && !map.has(key)) map.set(key, tr);
    }
    schedule();
  });

  new MutationObserver(() => {
    if (map.size) schedule();
  }).observe(document.body, { childList: true, subtree: true });
})();

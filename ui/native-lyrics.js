// Spotify 자체 가사 화면([data-testid="lyrics-line"]) 각 줄 아래에 번역을 끼워 넣는다.
// panel.js 가 'sltTranslations' 이벤트로 번역 결과를 넘겨준다. 줄 매칭은 원문 텍스트 기준이라 가사 출처와 무관.
(() => {
  const CLS = 'slt-native-tr';
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let map = new Map(); // 정규화된 원문 -> 번역
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

  // 가사 화면을 열거나 React가 줄을 다시 그리면 다시 붙인다 (번역이 있을 때만 일함)
  new MutationObserver(() => {
    if (map.size) schedule();
  }).observe(document.body, { childList: true, subtree: true });
})();

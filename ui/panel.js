(() => {
  const SLT = window.SLT;
  const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
  const LEAD_MS = 100;
  const UI_KEY = 'sltUi';
  const SVG = {
    close: '<path d="M3.3 2.3 8 7l4.7-4.7 1 1L9 8l4.7 4.7-1 1L8 9l-4.7 4.7-1-1L7 8 2.3 3.3z"/>',
    refresh: '<path d="M8 2a6 6 0 1 0 5.7 8h-1.6A4.5 4.5 0 1 1 8 3.5c1.2 0 2.4.5 3.2 1.3L9 7h5V2l-1.8 1.8A6 6 0 0 0 8 2z"/>',
    settings: '<path d="M2 3.3h6.6a2 2 0 0 1 3.8 0H14v1.4h-1.6a2 2 0 0 1-3.8 0H2zm8.5-.2a.8.8 0 1 0 0 1.8.8.8 0 0 0 0-1.8zM2 11.3h1.6a2 2 0 0 1 3.8 0H14v1.4H7.4a2 2 0 0 1-3.8 0H2zm3.5-.2a.8.8 0 1 0 0 1.8.8.8 0 0 0 0-1.8z"/>',
    original: '<path fill-rule="evenodd" d="M1.5 3h13c.8 0 1.5.7 1.5 1.5v7c0 .8-.7 1.5-1.5 1.5h-13C.7 13 0 12.3 0 11.5v-7C0 3.7.7 3 1.5 3zm0 1.5v7h13v-7zM3 6.5h6V8H3zm0 2.5h10v1.5H3z"/>'
  };

  let panel = null;
  let reopenBtn = null;
  const els = {};
  let track = null;
  let data = null;
  let token = 0;
  let activeIndex = -1;
  let following = true;
  let autoTimer = null;
  let settings = { autoTranslate: true, engine: 'deepl' };
  let ui = { open: true, hideOriginal: false, floating: null };

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  function iconButton(name, label, onclick) {
    const btn = el('button', { type: 'button', class: 'slt-icon-btn', 'aria-label': label, title: label, onclick });
    btn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${SVG[name]}</svg>`; // 고정 문자열만
    return btn;
  }

  function saveUi() {
    chrome.storage.local.set({ [UI_KEY]: ui }).catch(() => {});
  }

  // ── 생성 / 배치 ─────────────────────────────────────────────

  function createPanel() {
    if (panel) return;

    els.title = el('p', { id: 'slt-title' });
    els.titleTr = el('p', { id: 'slt-title-tr', hidden: '' });
    els.artist = el('p', { id: 'slt-artist' });
    els.toggleOriginal = iconButton('original', t('showOriginal'), () => {
      ui.hideOriginal = !ui.hideOriginal;
      applyUiFlags();
      saveUi();
    });
    // 페이지 스크립트의 가짜 클릭(isTrusted=false)으로 유료 번역을 반복시키지 못하게
    els.retranslate = iconButton('refresh', t('retranslate'), (e) => e.isTrusted && requestLyrics(true));
    els.header = el('div', { id: 'slt-header', title: t('headerHint') }, [
      el('div', { id: 'slt-titles' }, [els.title, els.titleTr, els.artist]),
      els.toggleOriginal,
      els.retranslate,
      iconButton('settings', t('settings'), openSettings),
      iconButton('close', t('closePanel'), () => setOpen(false))
    ]);
    // 가사 목록 자체는 live region 이 아니다 (다시 그릴 때마다 수십 줄을 읽어 버림). 알림은 #slt-status 한 줄로만.
    els.lyrics = el('div', {
      id: 'slt-lyrics', role: 'list', tabindex: '0', 'aria-busy': 'false',
      'aria-label': t('lyricsListLabel')
    });
    els.status = el('p', { id: 'slt-status', class: 'slt-sr-only', role: 'status' });
    els.follow = el('button', { type: 'button', id: 'slt-follow', hidden: '', text: t('jumpToCurrent'), onclick: resumeFollow });

    panel = el('aside', { id: 'slt-panel', role: 'complementary', 'aria-label': t('panelName'), hidden: '' }, [
      els.header,
      els.status,
      el('div', { id: 'slt-body' }, [els.lyrics, els.follow])
    ]);

    reopenBtn = el('button', { type: 'button', id: 'slt-reopen', hidden: '', title: 'Alt+L', onclick: () => setOpen(true) });
    reopenBtn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${SVG.original}</svg>`;
    reopenBtn.append(t('panelName'));

    document.body.append(panel, reopenBtn);
    els.lyrics.addEventListener('click', onLyricsClick);
    els.lyrics.addEventListener('keydown', onLyricsKey);
    setupDrag();
    setupFollow();
    applyUiFlags();
    new ResizeObserver(onPanelResize).observe(panel);
    setInterval(place, 1000);
    window.addEventListener('resize', place);
  }

  function applyUiFlags() {
    if (!panel) return;
    panel.toggleAttribute('data-hide-original', ui.hideOriginal);
    els.toggleOriginal.setAttribute('aria-pressed', String(!ui.hideOriginal));
  }

  function setOpen(open) {
    ui.open = open;
    saveUi();
    syncVisibility();
  }

  function syncVisibility() {
    if (!panel) return;
    panel.hidden = !ui.open;
    reopenBtn.hidden = ui.open || !track;
    if (ui.open) {
      place();
      activeIndex = -1;
    }
  }

  function clampRect(r) {
    const width = Math.min(Math.max(r.width, 280), innerWidth - 16);
    const height = Math.min(Math.max(r.height, 240), innerHeight - 16);
    return {
      width,
      height,
      left: Math.min(Math.max(r.left, 8), innerWidth - width - 8),
      top: Math.min(Math.max(r.top, 8), innerHeight - height - 8)
    };
  }

  let lastRect = '';
  function setRect(r, mode) {
    const key = [mode, ...[r.left, r.top, r.width, r.height].map(Math.round)].join('|');
    if (key === lastRect) return;
    lastRect = key;
    panel.dataset.mode = mode;
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.top)}px`;
    panel.style.width = `${Math.round(r.width)}px`;
    panel.style.height = `${Math.round(r.height)}px`;
  }

  // 기본: Spotify 오른쪽 사이드바(Now Playing) 자리에 정확히 겹쳐 도킹. 사이드바가 닫혀 있으면 우측 하단 카드.
  function place() {
    if (!panel || panel.hidden || dragging) return;
    if (ui.floating) return setRect(clampRect(ui.floating), 'floating');
    const side = document.getElementById('Desktop_PanelContainer_Id')?.getBoundingClientRect();
    if (side && side.width >= 260 && side.height >= 240) return setRect(side, 'docked');
    const width = 360;
    setRect(clampRect({ width, height: innerHeight - 72 - 112, left: innerWidth - width - 16, top: 72 }), 'floating');
  }

  let dragging = false;
  function setupDrag() {
    let start = null;
    els.header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, r, moved: false };
      els.header.setPointerCapture(e.pointerId);
    });
    els.header.addEventListener('pointermove', (e) => {
      if (!start) return;
      // 버튼을 뗐는데 pointerup 을 못 받은 경우(페이지가 가로챔 등) 계속 따라다니지 않게
      if (!(e.buttons & 1)) return end();
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = dragging = true;
      ui.floating = clampRect({ left: start.r.left + dx, top: start.r.top + dy, width: start.r.width, height: start.r.height });
      setRect(ui.floating, 'floating');
    });
    function end() {
      if (!start) return;
      if (start.moved) saveUi();
      start = null;
      dragging = false;
    }
    els.header.addEventListener('pointerup', end);
    els.header.addEventListener('pointercancel', end);
    els.header.addEventListener('lostpointercapture', end);
    // Spotify 가 pointerup 전파를 막아도 받도록 window 캡처 단계에서도 끝낸다
    window.addEventListener('pointerup', end, true);
    els.header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      ui.floating = null;
      saveUi();
      place();
    });
  }

  let resizeSave = null;
  function onPanelResize() {
    if (!ui.floating || dragging || panel.dataset.mode !== 'floating') return;
    const w = panel.offsetWidth;
    const hgt = panel.offsetHeight;
    if (Math.abs(w - ui.floating.width) < 2 && Math.abs(hgt - ui.floating.height) < 2) return;
    ui.floating = { ...ui.floating, width: w, height: hgt };
    clearTimeout(resizeSave);
    resizeSave = setTimeout(saveUi, 300);
  }

  // ── 자동 스크롤 (사용자가 스크롤하면 멈추고 "현재 가사로 이동" 버튼 표시) ──

  function setupFollow() {
    const pause = () => {
      if (!data?.synced || !following) return;
      following = false;
      els.follow.hidden = false;
    };
    els.lyrics.addEventListener('wheel', pause, { passive: true });
    els.lyrics.addEventListener('touchmove', pause, { passive: true });
    els.lyrics.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) pause();
    });
    els.lyrics.addEventListener('pointerdown', (e) => {
      if (e.target === els.lyrics) pause(); // 스크롤바 드래그
    });
  }

  function resumeFollow() {
    following = true;
    els.follow.hidden = true;
    scrollToActive(true);
  }

  function scrollToActive(force) {
    const line = els.lyrics.children[activeIndex];
    if (!line || (!following && !force)) return;
    const c = els.lyrics;
    c.scrollTo({
      top: line.offsetTop - c.clientHeight * 0.4 + line.offsetHeight / 2,
      behavior: reducedMotion.matches ? 'auto' : 'smooth'
    });
  }

  // ── 렌더링 ────────────────────────────────────────────────

  function setHeader() {
    els.title.textContent = track?.title || t('waitingForTrack');
    els.title.title = track?.title || '';
    els.artist.textContent = track?.artist || '';
    els.artist.title = track?.artist || '';
    setTitleTranslation('');
  }

  function setTitleTranslation(text) {
    const tr = (text || '').trim();
    const show = !!tr && tr !== (track?.title || '').trim();
    els.titleTr.hidden = !show;
    els.titleTr.textContent = show ? tr : '';
    els.titleTr.title = show ? tr : '';
    if (show) els.titleTr.lang = targetLangTag();
  }

  function showState({ title, body, action, error }) {
    data = null;
    activeIndex = -1;
    els.follow.hidden = true;
    els.lyrics.dataset.synced = 'false';
    els.lyrics.setAttribute('aria-busy', 'false');
    if (!error) announce([title, body].filter(Boolean).join('. '));
    els.lyrics.replaceChildren(el('div', { class: `slt-state${error ? ' slt-error' : ''}`, role: error ? 'alert' : null }, [
      title && el('strong', { text: title }),
      body && el('span', { text: body }),
      action && el('button', { type: 'button', class: 'slt-primary', text: action.label, onclick: action.run })
    ]));
  }

  function showLoading() {
    data = null;
    els.lyrics.dataset.synced = 'false';
    els.lyrics.setAttribute('aria-busy', 'true');
    announce(t('searchingLyrics'));
    els.lyrics.replaceChildren(el('div', { class: 'slt-state' }, [el('span', { text: t('searchingLyricsVisible') })]),
      ...Array.from({ length: 6 }, () => el('div', { class: 'slt-line', 'aria-hidden': 'true' }, [el('span', { class: 'slt-pending' })])));
  }

  function renderLines(lines, { synced, pending, language }) {
    activeIndex = -1;
    els.lyrics.dataset.synced = String(!!synced);
    els.lyrics.setAttribute('aria-busy', String(!!pending));
    els.follow.hidden = true;
    following = true;

    const nodes = lines.map((line, i) => {
      const text = (line.text || '').trim();
      if (!text || /^[♪♫♩♬\s]+$/.test(text)) {
        return el('div', { class: 'slt-line slt-gap', role: 'listitem', tabindex: '-1', 'aria-label': t('instrumental'), dataset: { i } },
          [el('p', { class: 'slt-original', 'aria-hidden': 'true', text: '♪' })]);
      }
      const translated = (line.translated || '').trim();
      const hasTranslation = translated && translated !== text;
      const node = el('div', { class: 'slt-line', role: 'listitem', tabindex: '-1', dataset: { i } }, [
        el('p', { class: 'slt-original', ...(language && { lang: language }), text }),
        hasTranslation && el('p', { class: 'slt-translated', lang: targetLangTag(), text: translated }),
        pending && el('span', { class: 'slt-pending', 'aria-hidden': 'true' })
      ]);
      if (!hasTranslation && !pending) node.dataset.onlyOriginal = '';
      return node;
    });
    els.lyrics.replaceChildren(...nodes);
    els.lyrics.scrollTop = 0;
  }

  function render(res) {
    if (!res || res.error) return renderError(res?.error || t('unknownError'));
    data = res;
    window.dispatchEvent(new CustomEvent('sltTranslations', { detail: { lines: res.lines, lang: targetLangTag() } })); // native-lyrics.js
    setTitleTranslation(res.titleTranslated);
    renderLines(res.lines, { synced: res.synced, language: res.language });
    if (!res.synced) els.lyrics.prepend(el('p', { class: 'slt-note', text: t('noTimingNote') }));
    announce(t(res.synced ? 'loadedSynced' : 'loaded', res.lines.length));
    if (res.partial) {
      els.lyrics.append(el('p', { class: 'slt-note', text: t('partialNote') }));
    }
  }

  function renderError(code) {
    if (code === 'NO_KEY') {
      return showState({
        title: t('noKeyTitle'),
        body: t('noKeyBody'),
        action: { label: t('openSettings'), run: openSettings }
      });
    }
    if (code === 'NO_LYRICS') {
      return showState({
        title: t('noLyricsTitle'),
        body: t('noLyricsBody'),
        action: { label: t('retry'), run: () => requestLyrics(true) }
      });
    }
    showState({ title: t('translateFailedTitle'), body: code, error: true, action: { label: t('retry'), run: () => requestLyrics(true) } });
  }

  // 같은 문구도 다시 읽히도록 비웠다가 다음 프레임에 채운다
  function announce(text) {
    if (!els.status) return;
    els.status.textContent = '';
    requestAnimationFrame(() => { els.status.textContent = text; });
  }

  function targetLangTag() {
    return (settings.targetLang || 'KO').toLowerCase().replace('zh', 'zh-Hans');
  }

  function showIdle() {
    if (!track) return showState({ body: t('idleNoTrack') });
    showState({ body: t('idleAutoOff'), action: { label: t('translateNow'), run: () => requestLyrics(false) } });
  }

  // ── 요청 ──────────────────────────────────────────────────

  async function requestLyrics(force) {
    const req = SLT.getTrack() || track;
    // 광고 감지(1초 주기) 전 틈에 들어온 재번역·설정 변경도 막는다
    if (!req || !panel || SLT.isAd()) return;
    track = req;
    setHeader();
    const my = ++token;
    showLoading();

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'FETCH_LYRICS', track: req, spotify: SLT.findSpotifyLyrics(req), force });
    } catch (_) {
      res = { error: t('extensionUpdated') };
    }
    // 곡 전환·광고 감지(1초 주기) 전에 도착한 이전 곡 응답도 걸러낸다
    const now = SLT.getTrack();
    if (my === token && !SLT.isAd() && (!now || sameTrack(now, req))) render(res);
  }

  function sameTrack(a, b) {
    return !!a && !!b && a.title === b.title && a.artist === b.artist && a.album === b.album;
  }

  function openSettings() {
    chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SHOW_PANEL') {
      createPanel();
      setHeader();
      if (!track) showIdle();
      setOpen(true);
      return;
    }
    if (msg?.type !== 'LYRICS_PROGRESS' || !panel || data) return;
    if (!sameTrack(msg, track)) return;
    if (msg.stage === 'translate' && Array.isArray(msg.lines)) {
      renderLines(msg.lines, { synced: msg.synced, pending: true });
      announce(t('foundTranslating'));
    }
  });

  // ── 현재 줄 강조 ───────────────────────────────────────────

  function findActive(lines, ms) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].startTimeMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function tick() {
    if (!panel || panel.hidden || !data?.synced) return;
    const pos = SLT.getPositionMs();
    if (pos == null) return;
    const idx = findActive(data.lines, pos + LEAD_MS);
    if (idx === activeIndex) return;
    activeIndex = idx;
    const nodes = els.lyrics.children;
    for (let i = 0; i < data.lines.length && i < nodes.length; i++) {
      nodes[i].classList.toggle('slt-active', i === idx);
      nodes[i].classList.toggle('slt-past', i < idx);
      if (i === idx) nodes[i].setAttribute('aria-current', 'true');
      else nodes[i].removeAttribute('aria-current');
    }
    scrollToActive(false);
  }
  setInterval(tick, 120);

  function onLyricsClick(e) {
    if (!data?.synced) return;
    const line = e.target.closest('.slt-line');
    if (!line || window.getSelection()?.toString()) return;
    seekTo(Number(line.dataset.i));
  }

  function seekTo(i) {
    const ms = data?.lines[i]?.startTimeMs;
    if (ms == null) return;
    SLT.seek(ms);
    following = true;
    els.follow.hidden = true;
  }

  // 키보드: 위/아래로 줄 이동, Enter/Space 로 그 위치 재생
  function onLyricsKey(e) {
    const nodes = [...els.lyrics.querySelectorAll('.slt-line[data-i]')];
    if (!nodes.length) return;
    const current = e.target.closest?.('.slt-line[data-i]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const from = current ? nodes.indexOf(current) : Math.max(activeIndex, 0) - step;
      nodes[Math.min(Math.max(from + step, 0), nodes.length - 1)].focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && current && data?.synced) {
      e.preventDefault();
      seekTo(Number(current.dataset.i));
    }
  }

  // ── 이벤트 연결 ────────────────────────────────────────────

  window.addEventListener('trackChanged', (e) => {
    createPanel();
    track = e.detail;
    token++;
    data = null;
    window.dispatchEvent(new CustomEvent('sltTranslations', { detail: { lines: [] } }));
    setHeader();
    syncVisibility();
    clearTimeout(autoTimer);
    if (!settings.autoTranslate) return showIdle();
    showLoading();
    // 곡 길이(재생바 max)와 Spotify 가사 응답이 새 곡으로 바뀔 시간을 준다
    autoTimer = setTimeout(() => requestLyrics(false), 1500);
  });

  // 광고 중엔 요청하지 않는다: "광고"라는 제목으로 가사를 찾지 않고,
  // 이전 곡 가사가 광고 재생 위치에 맞춰 강조되지 않게 비운다
  window.addEventListener('adPlaying', () => {
    createPanel();
    track = null;
    token++;
    data = null;
    window.dispatchEvent(new CustomEvent('sltTranslations', { detail: { lines: [] } }));
    clearTimeout(autoTimer);
    setHeader();
    syncVisibility();
    showState({ body: t('idleAd') });
  });

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.code !== 'KeyL' || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    createPanel();
    setOpen(!ui.open);
  });

  // 설정은 바꾸는 즉시 저장되므로, 연달아 바꾸면 마지막 변경 1.5초 뒤 한 번만 다시 번역 (유료 API 호출 절약)
  let settingsTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.autoTranslate) settings.autoTranslate = changes.autoTranslate.newValue;
    if (area === 'sync' && changes.targetLang) settings.targetLang = changes.targetLang.newValue;
    const retranslate = area === 'sync' && ['engine', 'targetLang', 'register', 'claudeModel', 'preferSpotify'].some(k => changes[k]);
    const keyAdded = area === 'local' && (changes.deeplApiKey || changes.claudeApiKey);
    if (!retranslate && !keyAdded) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      if (panel && track && (data || settings.autoTranslate)) requestLyrics(false);
    }, 1500);
  });

  Promise.all([
    chrome.storage.sync.get({ autoTranslate: true, engine: 'deepl', targetLang: 'KO' }),
    chrome.storage.local.get({ [UI_KEY]: null })
  ]).then(([s, l]) => {
    settings = s;
    if (l[UI_KEY]) ui = { ...ui, ...l[UI_KEY] };
    applyUiFlags();
    syncVisibility();
    SLT.checkTrack(); // 설정을 읽은 뒤 첫 곡 감지 (자동 번역 꺼짐이면 번역하지 않게)
  });
})();

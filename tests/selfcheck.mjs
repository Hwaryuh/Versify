// node tests/selfcheck.mjs  - 네트워크 없이 파싱/매핑 로직만 확인
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLrc, fetchLyrics } from '../lyrics/lrclib.js';
import { parseSearch, parseSynced, parseDuration } from '../lyrics/bugs.js';
import { translateLines as deepl } from '../translate/deepl.js';
import { translateLines as claude } from '../translate/claude.js';
import { isInTargetLang, isTranslatable } from '../translate/style.js';

// LRC: 다중 태그, 분수 없는 태그, 메타 태그, 정렬
const lrc = '[ar:someone]\n[00:10.50][01:00.5]chorus\n[00:05]intro\n[00:20.123] verse\n[00:30.00]';
assert.deepEqual(parseLrc(lrc), [
  { startTimeMs: 5000, text: 'intro' },
  { startTimeMs: 10500, text: 'chorus' },
  { startTimeMs: 20123, text: 'verse' },
  { startTimeMs: 30000, text: '' },
  { startTimeMs: 60500, text: 'chorus' }
]);

assert.deepEqual(parseLrc('[00:99]bad\n[00:01]say [00:02] now'), [{ startTimeMs: 1000, text: 'say [00:02] now' }]);

const lines = ['first line', '♪', 'second line', 'first line', ''].map((text, i) => ({ startTimeMs: i * 1000, text }));

// DeepL: 이어지는 줄은 묶어서 한 text 로, context 포함, 50개 청크, custom_instructions 거부 시 재시도
const calls = [];
const perLine = t => t.split(' | ').map(s => `T(${s})`).join(' | ');
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  if (body.custom_instructions) return { ok: false, status: 400 };
  return { ok: true, status: 200, json: async () => ({ translations: body.text.map(t => ({ text: perLine(t) })) }) };
};
let r = await deepl(lines, { targetLang: 'KO', register: 'casual', apiKey: 'abc:fx' });
assert.deepEqual(r.translations, ['T(first line)', '', 'T(second line)', 'T(first line)', '']);
assert.equal(r.complete, true);
assert.deepEqual(calls[1].body.text, ['first line', 'second line | first line'], '♪ 에서 끊고 이어지는 줄은 묶음');
assert.match(calls[1].body.context, /second line/);
assert.equal(calls[1].body.formality, 'prefer_less');
assert.match(calls[0].url, /api-free\.deepl\.com/);

calls.length = 0;
const many = Array.from({ length: 120 }, (_, i) => [{ startTimeMs: i, text: `line ${i}` }, { startTimeMs: i, text: '♪' }]).flat();
r = await deepl(many, { targetLang: 'KO', register: 'polite', apiKey: 'pro-key' });
// ♪ 마다 끊겨 120 묶음. Pro 호스트는 따로 기억: 첫 청크만 거부 후 재시도, 이후 50 + 20 은 지시문 없이 -> 1 + 3
assert.equal(calls.length, 4);
assert.equal(calls.filter(c => c.body.custom_instructions).length, 1);
assert.equal(calls[1].body.formality, 'prefer_more');
assert.match(calls[0].url, /api\.deepl\.com/);
assert.equal(r.translations[238], 'T(line 119)');

// 긴 묶음은 고르게 나누고 (9 -> 5+4), standalone 줄(제목)은 따로, 같은 묶음은 한 번만
calls.length = 0;
const nine = Array.from({ length: 9 }, (_, i) => ({ startTimeMs: i, text: `v${i}` }));
r = await deepl([...nine, { startTimeMs: 9, text: '♪' }, ...nine, { startTimeMs: 0, text: 'Title', standalone: true }], { targetLang: 'KO', register: 'casual', apiKey: 'abc:fx' });
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].body.text, ['v0 | v1 | v2 | v3 | v4', 'v5 | v6 | v7 | v8', 'Title']);
assert.equal(r.translations[10], 'T(v0)', '같은 묶음 번역 재사용');
assert.equal(r.translations[19], 'T(Title)');
assert.equal(r.complete, true);

// 줄 수가 안 맞거나 빈 줄이 오면 그 묶음만 한 줄씩 다시. 그래도 비면 complete=false
calls.length = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const out = t => (t === 'a | b' ? 'AB merged' : t === 'c | d' ? 'C |' : t === 'd' ? '' : t.toUpperCase());
  return { ok: true, status: 200, json: async () => ({ translations: body.text.map(t => ({ text: out(t) })) }) };
};
const merged = ['a', 'b', '♪', 'c', 'd', '♪', 'e\nf', 'g|h'].map((text, i) => ({ startTimeMs: i, text }));
r = await deepl(merged, { targetLang: 'KO', register: 'casual', apiKey: 'abc:fx' });
assert.deepEqual(calls[0].body.text, ['a | b', 'c | d', 'e f | g/h'], '줄 안의 줄바꿈은 공백, 구분자 문자는 / 로');
assert.deepEqual(calls[1].body.text, ['a', 'b', 'c', 'd']);
assert.deepEqual(r.translations, ['A', 'B', '', 'C', '', '', 'E F', 'G/H']);
assert.equal(r.complete, false);

// Claude: 번호 매핑, 범위 밖/중복 무시, 누락 시 complete=false
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.match(body.system, /반말/);
  assert.equal(body.messages[0].content, '0\tfirst line\n2\tsecond line\n3\tfirst line');
  const out = { lines: [{ i: 0, t: 'A' }, { i: 0, t: 'dup' }, { i: 99, t: 'x' }, { i: 2, t: 'B' }] };
  return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }) };
};
r = await claude(lines, { targetLang: 'KO', register: 'casual', apiKey: 'k' });
assert.deepEqual(r.translations, ['A', '', 'B', '', '']);
assert.equal(r.complete, false);

// 대상 언어 판별: 글자 절반 넘게 대상 언어 문자면 이미 그 언어 (반반·영어 우세는 번역)
assert.equal(isInTargetLang('너를 사랑해', 'KO'), true);
assert.equal(isInTargetLang('ㅋㅋㅋ oh', 'KO'), true);
assert.equal(isInTargetLang('Baby 너만 보여', 'KO'), false, '반반이면 번역');
assert.equal(isInTargetLang('I need you 너 없인', 'KO'), false);
assert.equal(isInTargetLang('2024', 'KO'), false, '글자 없으면 번역 대상 판정은 SKIP_RE 몫');
assert.equal(isInTargetLang('愛してる', 'JA'), true);
assert.equal(isInTargetLang('ラーメン', 'JA'), true, '장음 기호');
assert.equal(isInTargetLang('我爱你', 'JA'), false, '가나 없으면 중국어일 수 있음');
assert.equal(isInTargetLang('我爱你', 'ZH'), false, 'ZH 는 판별 안 함');
assert.equal(isInTargetLang('너를 사랑해', 'EN-US'), false);
assert.equal(isTranslatable('너를 사랑해'), true, '대상 언어 안 주면 기존 동작');

// 한국어 대상: 한국어 줄은 보내지 않고 (DeepL 은 context 에만, Claude 는 '-' 문맥 줄로) 영어 줄만 번역
const mixed = ['너를 사랑해', 'I love you', '♪', '너를 사랑해'].map((text, i) => ({ startTimeMs: i * 1000, text }));
calls.length = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  return { ok: true, status: 200, json: async () => ({ translations: body.text.map(t => ({ text: `T(${t})` })) }) };
};
r = await deepl(mixed, { targetLang: 'KO', register: 'casual', apiKey: 'abc:fx' });
assert.deepEqual(calls.at(-1).body.text, ['I love you']);
assert.match(calls.at(-1).body.context, /너를 사랑해/);
assert.deepEqual(r.translations, ['', 'T(I love you)', '', '']);
assert.equal(r.complete, true);
calls.length = 0;
r = await deepl(mixed.filter(l => l.text !== 'I love you'), { targetLang: 'KO', register: 'casual', apiKey: 'abc:fx' });
assert.equal(calls.length, 0, '전부 한국어면 API 호출 없음');
assert.equal(r.complete, true);

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  assert.equal(body.messages[0].content, '-\t너를 사랑해\n1\tI love you\n-\t너를 사랑해');
  const out = { lines: [{ i: 0, t: 'x' }, { i: 1, t: '사랑해' }] };
  return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }) };
};
r = await claude(mixed, { targetLang: 'KO', register: 'casual', apiKey: 'k' });
assert.deepEqual(r.translations, ['', '사랑해', '', ''], '문맥 줄 번호로 온 응답은 무시');
assert.equal(r.complete, true);

// i18n: 코드에서 쓰는 키가 전부 messages.json 에 있는지 (없으면 화면에 키 이름이 그대로 나옴)
const messages = JSON.parse(readFileSync(new URL('../_locales/ko/messages.json', import.meta.url), 'utf8'));
for (const file of ['background/service-worker.js', 'lyrics/lrclib.js', 'lyrics/bugs.js', 'translate/deepl.js', 'translate/claude.js', 'ui/panel.js', 'ui/popup.js', 'ui/popup.html', 'ui/options.js', 'ui/options.html', 'manifest.json']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const m of src.matchAll(/'(\w+)'|data-i18n(?:-label)?="(\w+)"|__MSG_(\w+)__/g)) {
    const key = m[1] || m[2] || m[3];
    // '...' 는 키처럼 생긴 문자열 전부라서, t( 근처에 있는 것만 본다
    if (m[1] && !/\bt\([^)]*$/.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
    assert.ok(messages[key], `${file}: messages.json 에 없는 키 ${key}`);
  }
}

// player-observer: 이전 곡에 쓴 Spotify 가사를 다음 곡에 다시 붙이지 않는지 (앨범아트가 같아 보여도)
{
  const vm = await import('node:vm');
  let onMessage = null;
  const meta = { title: 'A', artist: 'x', album: 'p', artwork: [{ src: 'https://i.scdn.co/image/ab67616d0000b273' + 'a'.repeat(24) }] };
  const dataset = {};
  let pageTrackId = ''; // page-hook 이 읽어 줄 현재 곡 trackId ('' = 못 읽음)
  let adShown = false; // 광고 중이면 위젯에 ad-controls 가 있다
  const events = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') onMessage = fn; },
    postMessage() {},
    dispatchEvent(e) {
      events.push(e.type);
      if (e.type === 'slt-read-track') dataset.sltTrackId = pageTrackId;
    }
  };
  const ctx = vm.createContext({
    window: win, navigator: { mediaSession: { metadata: meta } }, location: { origin: 'https://open.spotify.com' },
    document: { querySelector: sel => (adShown && sel.includes('ad-controls') ? {} : null), documentElement: { dataset } },
    performance: { now: () => 0 }, Date,
    MutationObserver: class { observe() {} disconnect() {} }, CustomEvent: class { constructor(type) { this.type = type; } }, setInterval() {}
  });
  win.SLT = undefined;
  vm.runInContext(readFileSync(new URL('../content/player-observer.js', import.meta.url), 'utf8'), ctx);
  const SLT = ctx.window.SLT;
  SLT.checkTrack();
  onMessage({ source: win, data: { source: 'slt-hook', type: 'SPOTIFY_LYRICS', entry: {
    trackId: 'trackA', artworkHash: 'a'.repeat(24), syncType: 'UNSYNCED', lines: [{ startTimeMs: 0, text: 'old song' }], capturedAt: Date.now()
  } } });
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack())?.trackId, 'trackA');
  meta.title = 'B'; meta.album = 'q'; // 새 곡, 아트는 그대로 읽힘
  SLT.checkTrack();
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack()), null);
  meta.title = 'A'; meta.album = 'p';
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack())?.trackId, 'trackA', '같은 곡에는 계속 쓴다');

  // trackId 를 알면 앨범 아트가 같은 다른 곡(다음 곡 prefetch) 가사를 붙이지 않는다
  meta.title = 'C'; meta.album = 'p';
  SLT.checkTrack();
  onMessage({ source: win, data: { source: 'slt-hook', type: 'SPOTIFY_LYRICS', entry: {
    trackId: 'nextTrack', artworkHash: 'a'.repeat(24), syncType: 'LINE_SYNCED', lines: [{ startTimeMs: 1000, text: 'next song' }], capturedAt: Date.now()
  } } });
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack())?.trackId, 'nextTrack', 'trackId 를 못 읽으면 앨범 아트 대체 경로');
  pageTrackId = 'currentNoLyrics';
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack()), null, '현재 곡 가사가 없으면 null -> LRCLIB');
  pageTrackId = 'nextTrack';
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack())?.trackId, 'nextTrack');
  meta.title = 'D'; // 곡은 바뀌었는데 위젯은 아직 이전 곡 trackId
  SLT.checkTrack();
  assert.equal(SLT.findSpotifyLyrics(SLT.getTrack()), null, '이전 곡에 쓴 가사를 새 곡에 붙이지 않는다');

  // 광고: 곡으로 보지 않고 adPlaying 한 번만. 광고 뒤엔 같은 곡이어도 trackChanged
  events.length = 0;
  adShown = true;
  meta.title = '광고'; meta.artist = ''; meta.album = '';
  SLT.checkTrack();
  SLT.checkTrack();
  assert.equal(SLT.getTrack(), null);
  assert.deepEqual(events.filter(e => e !== 'slt-read-track'), ['adPlaying']);
  adShown = false;
  meta.title = 'D'; meta.artist = 'x'; meta.album = 'q';
  SLT.checkTrack();
  assert.deepEqual(events.filter(e => e !== 'slt-read-track'), ['adPlaying', 'trackChanged']);
}

// lrclib: 로마자 아티스트명이면 MusicBrainz 원어 이름으로 다시 검색, 아티스트별 캐시
{
  const searched = [];
  let mbCalls = 0;
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'musicbrainz.org') {
      mbCalls++;
      return json({ artists: [
        { name: 'Yutaka Ozaki Tribute', aliases: [] },
        { name: '尾崎紀世彦', aliases: [{ name: 'Kiyohiko Ozaki' }] }, // 이름이 안 맞음 -> 제외
        { name: '尾崎豊', aliases: [{ name: 'yutaka ozaki' }, { name: '”öè–L' }] } // 깨진 라틴 별칭 -> 제외
      ] });
    }
    if (u.pathname === '/api/get') return json(null, 404);
    if (u.pathname === '/api/search') {
      const a = u.searchParams.get('artist_name');
      searched.push(a ?? `q:${u.searchParams.get('q')}`);
      return json(a === '尾崎豊' && u.searchParams.get('track_name') === '愛の消えた街' ? [{ duration: 284, syncedLyrics: '[00:01]native' }] : []);
    }
    return json(null, 404);
  };
  const track = { title: '愛の消えた街', artist: 'Yutaka Ozaki', album: '', durationMs: 284000 };
  r = await fetchLyrics(track);
  assert.equal(r.lines[0].text, 'native');
  assert.deepEqual(searched, ['Yutaka Ozaki', '尾崎豊']);
  await fetchLyrics(track);
  assert.equal(mbCalls, 1, '같은 아티스트는 다시 조회하지 않는다');
  searched.length = 0;
  r = await fetchLyrics({ ...track, artist: '尾崎豊', title: 'none' });
  assert.equal(mbCalls, 1, '이미 원어면 MusicBrainz 를 부르지 않는다');
  assert.deepEqual(searched, ['尾崎豊', 'q:none']);
}

// lrclib: 라이브 버전(전각 괄호)이면 길이 다른 원곡 가사를 싱크 없이 쓴다. 버전 표기 없는 제목엔 안 씀
{
  const studio = { trackName: '夏の終りのハーモニー', duration: 263, syncedLyrics: '[00:10]studio line\n[00:12]' };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.host === 'musicbrainz.org') return json({ artists: [] });
    if (u.pathname === '/api/search' && u.searchParams.get('q') === '夏の終りのハーモニー') return json([studio]);
    if (u.pathname === '/api/search') return json([]);
    return json(null, 404);
  };
  const live = { title: '夏の終りのハーモニー（2005LIVE）', artist: 'Koji Tamaki', album: '', durationMs: 330000 };
  r = await fetchLyrics(live);
  assert.deepEqual(r, { lines: [{ startTimeMs: 0, text: 'studio line' }], synced: false, source: 'lrclib' });
  assert.equal(await fetchLyrics({ ...live, title: '夏の終りのハーモニー' }), null, '버전 표기 없으면 다른 아티스트 레코드 안 씀');

  // 제목만 같은 다른 곡이 섞이면 (첫 줄 불일치) 포기
  const other = { trackName: '夏の終りのハーモニー', duration: 200, plainLyrics: 'different song' };
  const base = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('q') === '夏の終りのハーモニー') return json([studio, other]);
    return base(url);
  };
  assert.equal(await fetchLyrics(live), null, '첫 줄이 다르면 같은 곡이라는 근거 없음');
  globalThis.fetch = base;
}

// 버전 표기 판별: 단어 경계 ("(Olive)" 는 지우지 않음)
{
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/search') seen.push(u.searchParams.get('track_name') ?? u.searchParams.get('q'));
    return u.host === 'musicbrainz.org' ? json({ artists: [] }) : u.pathname === '/api/search' ? json([]) : json(null, 404);
  };
  for (const t of ['Alive (Olive)', 'Song (Remastered 2011)', 'Song - Live at Budokan', '曲（2005LIVE）', 'Track (Remix)']) {
    seen.length = 0;
    await fetchLyrics({ title: t, artist: 'x', album: '', durationMs: 200000 });
    assert.equal(seen[0], { 'Alive (Olive)': 'Alive (Olive)', '曲（2005LIVE）': '曲' }[t] ?? (t.startsWith('Song') ? 'Song' : 'Track'), t);
  }
}

// lrclib 503 (DB 에 없는 곡을 밖에서 찾다가 바쁨): 한 번 재시도, 실패한 단계는 건너뛰고 다음 단계로
{
  const busy = { ok: false, status: 503, headers: { get: () => '0.01' } };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const hits = {};
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const step = u.pathname + (u.searchParams.has('q') ? '?q' : '');
    hits[step] = (hits[step] || 0) + 1;
    if (u.host === 'musicbrainz.org') return json({ artists: [] });
    if (step === '/api/get') return hits[step] === 1 ? busy : json(null, 404);
    if (step === '/api/search') return busy;
    if (step === '/api/search?q') return json([{ duration: 200, syncedLyrics: '[00:01]found' }]);
    return json(null, 404);
  };
  r = await fetchLyrics({ title: 'Indie', artist: 'Nobody', album: '', durationMs: 200000 });
  assert.equal(r.lines[0].text, 'found', '아티스트 검색이 503 이어도 제목 검색으로 진행');
  assert.equal(hits['/api/get'], 2, '503 은 한 번 재시도');
  assert.equal(hits['/api/search'], 2, '재시도도 503 이면 포기 (무한 재시도 없음)');

  globalThis.fetch = async (url) => (new URL(String(url)).host === 'musicbrainz.org' ? json({ artists: [] }) : busy);
  await assert.rejects(fetchLyrics({ title: 'Indie', artist: 'Nobody', album: '', durationMs: 200000 }),
    { message: 'errLyricsServer' }, '"HTTP 503" 을 화면에 그대로 내보내지 않는다');
}

// 벅스: 검색 HTML 파싱, 싱크 가사 형식, 같은 제목 다른 곡은 길이로 거른다
{
  const row = (id, title, artist, album) => `<tr albumId="1" artistId="2" trackId="${id}" multiArtist="N" rowType="track" >
    <th scope="row"><p class="title" adult_yn="N"><a href="javascript:;" title="${title}" aria-label="새창">${title}</a></p></th>
    <td class="left"><p class="artist"><a href="/artist/2" title="${artist}">${artist}</a></p></td>
    <td class="left"><a href="/album/1" class="album" title="${album}">${album}</a></td></tr>`;
  const html = row(34029104, '하얀 섬', 'Sagi', 'Sagi EP') + row(32419053, '하얀 섬', '이희상', 'WHOEVER') +
    row(1, 'Tom &amp; Jerry', 'A', 'B') + '<tr rowType="track"><td>no id</td></tr>';
  assert.deepEqual(parseSearch(html).map(r => [r.id, r.title, r.artists, r.album]), [
    ['34029104', '하얀 섬', ['Sagi'], 'Sagi EP'],
    ['32419053', '하얀 섬', ['이희상'], 'WHOEVER'],
    ['1', 'Tom & Jerry', ['A'], 'B']
  ]);
  assert.deepEqual(parseSynced('8.0|둘째＃4.6|하얀 섬＃bad＃9|'), [
    { startTimeMs: 4600, text: '하얀 섬' }, { startTimeMs: 8000, text: '둘째' }, { startTimeMs: 9000, text: '' }
  ]);
  assert.deepEqual(parseSynced(''), []);
  assert.equal(parseDuration('"duration": "PT1M56S"'), 116);
  assert.equal(parseDuration('"duration": "PT"'), 0);

  const lengths = { 34029104: 'PT3M30S', 32419053: 'PT1M56S' };
  const text = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) });
  const bugsHits = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.host === 'musicbrainz.org') return text('{"artists":[]}');
    if (u.host === 'lrclib.net') return u.pathname === '/api/search' ? text('[]') : text('null', 404);
    if (u.host !== 'music.bugs.co.kr') return text('', 404);
    bugsHits.push(u.pathname);
    if (u.pathname === '/search/track') return text(html);
    const track = /^\/track\/(\d+)$/.exec(u.pathname);
    if (track) return text(`{"duration": "${lengths[track[1]]}"}`);
    const lyr = /^\/player\/lyrics\/([TN])\/(\d+)$/.exec(u.pathname);
    assert.equal(init?.headers?.['X-Requested-With'], 'XMLHttpRequest');
    if (lyr[2] !== '32419053') return text('{"lyrics":"wrong song"}');
    return text(JSON.stringify({ lyrics: lyr[1] === 'T' ? '4.6|하얀 섬＃8.0|우리 그 위에 집을 짓자' : 'x' }));
  };
  r = await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: 'WHOEVER', durationMs: 116000 });
  assert.deepEqual(r, { lines: [{ startTimeMs: 4600, text: '하얀 섬' }, { startTimeMs: 8000, text: '우리 그 위에 집을 짓자' }], synced: true, source: 'bugs' });
  assert.equal(bugsHits[1], '/track/32419053', '앨범이 맞는 후보부터 길이를 본다');

  assert.equal(await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: '', durationMs: 200000 }), null, '길이가 안 맞으면 같은 제목이어도 안 쓴다');
  assert.equal(await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: 'WHOEVER', durationMs: 0 }), null, '길이를 모르면 앨범만으로는 안 쓴다');
  r = await fetchLyrics({ title: '하얀 섬', artist: '이희상', album: '', durationMs: 0 });
  assert.equal(r?.source, 'bugs', '길이를 모르면 아티스트 이름이 같을 때만');

  r = await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: '', durationMs: 116000 });
  assert.equal(r?.source, 'bugs', '아티스트·앨범이 안 맞아도 길이 맞는 후보가 하나면 쓴다');
  lengths[34029104] = 'PT1M57S';
  assert.equal(await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: '', durationMs: 116000 }), null, '길이 맞는 다른 곡이 둘 이상이면 고르지 않는다');
  r = await fetchLyrics({ title: '하얀 섬', artist: 'LEEHEESANG', album: 'WHOEVER', durationMs: 116000 });
  assert.equal(r?.lines[0].text, '하얀 섬', '앨범이 맞으면 길이 같은 다른 곡이 있어도 고른다');
}

console.log('selfcheck ok');

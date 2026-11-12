// 가사 소스들이 같이 쓰는 텍스트 도우미

function plainLines(text) {
  return text.split(/\r?\n/).map(t => ({ startTimeMs: 0, text: t.trim() })).filter(l => l.text);
}

// "Song - Remastered 2011", "Song (feat. X)", "曲（2005LIVE）" 같은 꼬리 제거 (검색용).
// NFKC 로 전각 괄호·영숫자를 반각으로 맞춘다
// 글자 경계 필수: "(Alive)", "Olive" 는 버전 표기가 아니다. "2005LIVE" 처럼 숫자 붙은 건 허용
const VERSION = '(?<![a-z])(?:remaster(?:ed)?|version|ver\\.|live|edit|re-?mix|mix|mono|stereo|acoustic)(?![a-z])';
const VERSION_TAIL = new RegExp(`\\s+-\\s+.*${VERSION}.*$`, 'i');
const VERSION_PAREN = new RegExp(`\\s*[([][^)\\]]*${VERSION}[^)\\]]*[)\\]]`, 'i');

function cleanTitle(title) {
  return title.normalize('NFKC')
    .replace(VERSION_TAIL, '')
    .replace(/\s*[([](feat|ft|with)\.?\s[^)\]]*[)\]]/i, '')
    .replace(VERSION_PAREN, '')
    .trim();
}

const isVersionVariant = title => VERSION_TAIL.test(title.normalize('NFKC')) || VERSION_PAREN.test(title.normalize('NFKC'));

export { cleanTitle, isVersionVariant, plainLines };

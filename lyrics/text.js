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

// 공백·구두점·대소문자 차이를 무시한 비교용 키
const norm = s => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// 검색 결과 제목이 우리 곡 제목과 같은 곡인가 (버전·feat 꼬리는 무시). 부분 일치("연애" vs "나 그거하나봐 연애")는 다른 곡이다
const sameTitle = (a, b) => {
  const key = norm(cleanTitle(a || ''));
  return !!key && key === norm(cleanTitle(b || ''));
};

export { cleanTitle, isVersionVariant, norm, plainLines, sameTitle };

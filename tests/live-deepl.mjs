// 실제 DeepL API로 translate/deepl.js 를 검증한다 (키 필요, 무료 사용량 약 300자 소모).
//   키 위치: 환경변수 DEEPL_API_KEY 또는 프로젝트 루트의 .env.local 의 DEEPL_API_KEY=...
//   실행:    node tests/live-deepl.mjs
// 키는 출력하지 않는다. 테스트 문장은 직접 쓴 예문 (가사 아님).
import { readFileSync } from 'node:fs';
import { translateLines } from '../translate/deepl.js';

function loadKey() {
  if (process.env.DEEPL_API_KEY) return process.env.DEEPL_API_KEY;
  try {
    const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    return /^DEEPL_API_KEY\s*=\s*(.+)$/m.exec(env)?.[1].trim().replace(/^["']|["']$/g, '');
  } catch (_) {
    return null;
  }
}

const apiKey = loadKey();
if (!apiKey) {
  console.error('DEEPL_API_KEY 가 없습니다 (.env.local 또는 환경변수)');
  process.exit(1);
}

// 요청마다 상태 코드와 지시문 포함 여부만 기록
const nativeFetch = globalThis.fetch;
const log = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const res = await nativeFetch(url, init);
  log.push({ host: new URL(url).host, status: res.status, customInstructions: !!body.custom_instructions, formality: body.formality, texts: body.text.length });
  return res;
};

// 한 문장이 두 줄에 걸친 예문 + 반복 줄
const lines = [
  'When the city lights go quiet',
  'and the last train leaves without me,',
  'I keep walking toward your window.',
  'Do you still remember the summer we lost?',
  'I keep walking toward your window.'
].map((text, i) => ({ startTimeMs: i * 1000, text }));

for (const register of ['casual', 'polite']) {
  log.length = 0;
  const { translations, complete } = await translateLines(lines, { targetLang: 'KO', register, apiKey });
  console.log(`\n[${register === 'casual' ? '반말' : '존댓말'}] complete=${complete}`);
  translations.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log('  requests:', JSON.stringify(log));
}

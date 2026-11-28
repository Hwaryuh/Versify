// Verifies translate/deepl.js against the real DeepL API (needs a key, uses about 300 characters of free quota).
//   Key: env var DEEPL_API_KEY, or DEEPL_API_KEY=... in .env.local at the project root
//   Run: node tests/live-deepl.mjs
// The key is never printed. The test sentences are hand-written examples (not lyrics).
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

const nativeFetch = globalThis.fetch;
const log = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const res = await nativeFetch(url, init);
  log.push({ host: new URL(url).host, status: res.status, customInstructions: !!body.custom_instructions, formality: body.formality, texts: body.text.length });
  return res;
};

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

import { isTranslatable, registerRule } from './style.js';
import { t } from '../i18n.js';

const MAX_TEXTS_PER_REQUEST = 50; // DeepL 제한
const MAX_BLOCK_LINES = 8; // 실측으로 8줄 묶음은 줄 수가 맞았다. 더 길면 어긋날 위험이 커진다
// 묶음 안의 줄 구분자. 줄바꿈은 custom_instructions 를 같이 보내면 DeepL 이 공백으로 합쳐 버려서 못 쓴다 (실측).
const SEP = ' | ';
const SEP_RE = /\s*[|｜]\s*/;
const customInstructionsRejected = new Set(); // `${host}|${lang}` 단위로 기억

function normalizeKey(apiKey) {
  if (typeof apiKey !== 'string') throw new Error(t('deeplKeyInvalidType'));
  const key = apiKey.replace(/[​-‍⁠﻿]/g, '').trim();
  if (!key) throw new Error(t('deeplKeyMissing'));
  if (!/^[\x21-\x7E]+$/.test(key)) throw new Error(t('keyBadChars'));
  return key;
}

function hostFor(key) {
  return key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

async function request(key, body) {
  const host = hostFor(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function deeplError(status) {
  if (status === 403) return new Error(t('deeplKeyRejected'));
  if (status === 456) return new Error(t('deeplQuotaExceeded'));
  if (status === 429) return new Error(t('deeplRateLimited'));
  return new Error(t('deeplHttpError', status));
}

async function translateChunk(key, texts, base) {
  const memo = `${hostFor(key)}|${base.target_lang}`;
  const withInstructions = !customInstructionsRejected.has(memo) && base.custom_instructions;
  const body = { ...base, text: texts };
  if (!withInstructions) delete body.custom_instructions;

  let res = await request(key, body);
  if (withInstructions && (res.status === 400 || res.status === 403)) {
    // Free 플랜/언어에서 custom_instructions 미지원일 수 있음 -> 한 번만 빼고 재시도
    delete body.custom_instructions;
    res = await request(key, body);
    if (res.ok) customInstructionsRejected.add(memo);
  }
  if (!res.ok) throw deeplError(res.status);

  const data = await res.json();
  const out = (data.translations || []).map(t => (typeof t?.text === 'string' ? t.text.trim() : ''));
  if (out.length !== texts.length) throw new Error(t('deeplCountMismatch'));
  return out;
}

// 같은 text 는 한 번만 보낸다 (반복 후렴·같은 묶음)
async function translateAll(key, texts, base) {
  const unique = [...new Set(texts)];
  const map = new Map();
  for (let i = 0; i < unique.length; i += MAX_TEXTS_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_TEXTS_PER_REQUEST);
    const out = await translateChunk(key, chunk, base);
    chunk.forEach((t, j) => map.set(t, out[j]));
  }
  return map;
}

const oneLine = text => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[|｜]/g, '/').trim();

// 한 줄씩 따로 보내면 여러 줄에 걸친 문장이 끊겨 오역이 난다 ("it" 을 엉뚱한 명사로, 관계절 "Who ..." 를 의문문으로).
// 이어지는 번역 대상 줄을 MAX_BLOCK_LINES 까지 묶어 줄 인덱스 목록으로 돌려준다.
// 번역 안 하는 줄(♪, 빈 줄, 이미 대상 언어)과 standalone 줄(곡 제목)에서 끊는다.
function toBlocks(lines, wanted) {
  const runs = [];
  let run = [];
  const flush = () => { if (run.length) runs.push(run); run = []; };
  lines.forEach((l, i) => {
    if (!wanted(l.text)) return flush();
    if (l.standalone) { flush(); runs.push([i]); return; }
    run.push(i);
  });
  flush();
  // 긴 묶음은 고르게 나눈다 (16 -> 8+8, 9 -> 5+4)
  return runs.flatMap(r => {
    const size = Math.ceil(r.length / Math.ceil(r.length / MAX_BLOCK_LINES));
    return Array.from({ length: Math.ceil(r.length / size) }, (_, k) => r.slice(k * size, (k + 1) * size));
  });
}

async function translateLines(lines, { targetLang = 'KO', register = 'casual', apiKey }) {
  const key = normalizeKey(apiKey);

  // 이미 대상 언어인 줄은 번역하지 않고 context 로만 쓴다
  const wanted = text => isTranslatable(text, targetLang);
  const blocks = toBlocks(lines, wanted);
  if (!blocks.length) return { translations: lines.map(() => ''), complete: true };

  const base = {
    target_lang: targetLang,
    context: `Song lyrics, one line per row:\n${lines.map(l => l.text).join('\n')}`.slice(0, 20000),
    formality: register === 'polite' ? 'prefer_more' : 'prefer_less',
    split_sentences: '0',
    preserve_formatting: true,
    custom_instructions: [
      registerRule(targetLang, register),
      'Each text is one or more consecutive lines of the same song, separated by " | ". Keep every " | " separator and put exactly one translated line between separators, in the same order.'
    ]
  };

  const translations = lines.map(() => '');
  const texts = blocks.map(b => b.map(i => oneLine(lines[i].text)).join(SEP));
  const byBlock = await translateAll(key, texts, base);

  // 줄 수가 안 맞거나 빈 줄이 섞이면 그 묶음만 예전처럼 한 줄씩 다시 보낸다
  const retry = [];
  blocks.forEach((b, k) => {
    const parts = byBlock.get(texts[k]).split(SEP_RE);
    if (parts.length === b.length && parts.every(Boolean)) b.forEach((i, j) => { translations[i] = parts[j]; });
    else retry.push(...b);
  });
  if (retry.length) {
    const byLine = await translateAll(key, retry.map(i => oneLine(lines[i].text)), base);
    retry.forEach(i => { translations[i] = byLine.get(oneLine(lines[i].text)) || ''; });
  }

  const complete = lines.every((l, i) => !wanted(l.text) || translations[i]);
  return { translations, complete };
}

export { translateLines };

import { isTranslatable, registerRule } from './style.js';
import { t } from '../i18n.js';

const MAX_TEXTS_PER_REQUEST = 50; // DeepL 제한
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

async function translateLines(lines, { targetLang = 'KO', register = 'casual', apiKey }) {
  const key = normalizeKey(apiKey);

  // 반복되는 후렴은 한 번만 보내서 같은 번역을 재사용
  // 이미 대상 언어인 줄은 번역하지 않고 context 로만 쓴다
  const wanted = text => isTranslatable(text, targetLang);
  const unique = [...new Set(lines.map(l => l.text).filter(wanted))];
  if (!unique.length) return { translations: lines.map(() => ''), complete: true };

  const base = {
    target_lang: targetLang,
    context: `Song lyrics, one line per row:\n${lines.map(l => l.text).join('\n')}`.slice(0, 20000),
    formality: register === 'polite' ? 'prefer_more' : 'prefer_less',
    split_sentences: '0',
    preserve_formatting: true,
    custom_instructions: [
      registerRule(targetLang, register),
      'Each text is one line of the same song. Translate it as part of that song, consistent with the surrounding lines in the context.'
    ]
  };

  const map = new Map();
  for (let i = 0; i < unique.length; i += MAX_TEXTS_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_TEXTS_PER_REQUEST);
    const out = await translateChunk(key, chunk, base);
    chunk.forEach((t, j) => map.set(t, out[j]));
  }

  const translations = lines.map(l => (wanted(l.text) ? map.get(l.text) || '' : ''));
  const complete = lines.every((l, i) => !wanted(l.text) || translations[i]);
  return { translations, complete };
}

export { translateLines };

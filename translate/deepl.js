import { isTranslatable, registerRule } from './style.js';
import { t } from '../i18n.js';

const MAX_TEXTS_PER_REQUEST = 50;
const MAX_BLOCK_LINES = 8; // longer blocks risk misaligned line counts
// Line separator inside a block. A newline cannot be used: with custom_instructions DeepL merges it into a space.
const SEP = ' | ';
const SEP_RE = /\s*[|｜]\s*/;
const customInstructionsRejected = new Set();

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
    // The Free plan or a language may not support custom_instructions -> retry once without it.
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

// Groups consecutive lines to translate, up to MAX_BLOCK_LINES, and returns lists of line indexes.
// Breaks at lines that are not translated (♪, blank, already in the target language) and at standalone lines (the song title).
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
  return runs.flatMap(r => {
    const size = Math.ceil(r.length / Math.ceil(r.length / MAX_BLOCK_LINES));
    return Array.from({ length: Math.ceil(r.length / size) }, (_, k) => r.slice(k * size, (k + 1) * size));
  });
}

async function translateLines(lines, { targetLang = 'KO', register = 'casual', apiKey }) {
  const key = normalizeKey(apiKey);

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

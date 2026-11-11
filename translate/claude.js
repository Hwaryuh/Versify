import { isTranslatable, registerRule, LANG_NAMES } from './style.js';
import { t } from '../i18n.js';

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, t: { type: 'string' } },
        required: ['i', 't'],
        additionalProperties: false
      }
    }
  },
  required: ['lines'],
  additionalProperties: false
};

function systemPrompt(targetLang, register) {
  const lang = LANG_NAMES[targetLang] || targetLang;
  return [
    `You translate song lyrics into ${lang} for a listener who reads the translation while the song plays.`,
    'Read the whole song first, then translate it as one work: keep the same speaker, addressee, imagery and tone from start to finish.',
    registerRule(targetLang, register),
    'Lines are numbered. Return exactly one translation for every number you receive, using the same number. Lines marked "-" instead of a number are already in the target language: read them as context, never return them. A sentence may span several lines: translate it so each line still carries its own part in natural word order, and never merge or drop lines.',
    'Translate a repeated line the same way each time unless the context changes its meaning.',
    'Keep vocables and ad-libs (oh, yeah, la la) natural; keep proper nouns. If a line is already in the target language, return it unchanged.',
    'Output only the JSON object.'
  ].join('\n');
}

async function translateLines(lines, { targetLang = 'KO', register = 'casual', apiKey, model }) {
  if (!apiKey?.trim()) throw new Error(t('claudeKeyMissing'));

  const items = lines.map((l, i) => ({ i, text: l.text })).filter(x => isTranslatable(x.text, targetLang));
  if (!items.length) return { translations: lines.map(() => ''), complete: true };
  const wanted = new Set(items.map(x => x.i));
  // 이미 대상 언어인 줄은 번호 없이 문맥으로만 보낸다
  const content = lines
    .map((l, i) => (wanted.has(i) ? `${i}\t${l.text}` : isTranslatable(l.text) ? `-\t${l.text}` : ''))
    .filter(Boolean)
    .join('\n');

  const modelId = model || 'claude-opus-5-5';
  const withFallback = !modelId.startsWith('claude-haiku');
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey.trim(),
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (withFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  const body = {
    model: modelId,
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: systemPrompt(targetLang, register),
    messages: [{ role: 'user', content }]
  };
  if (withFallback) body.fallbacks = 'default';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    if (res.status === 401) throw new Error(t('claudeKeyRejected'));
    if (res.status === 429) throw new Error(t('claudeRateLimited'));
    const detail = await res.json().catch(() => null);
    throw new Error(t('claudeHttpError', res.status, detail?.error?.message ? `: ${detail.error.message}` : ''));
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error(t('claudeRefused'));
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error(data.stop_reason === 'max_tokens' ? t('claudeTruncated') : t('claudeUnreadable'));
  }

  if (!Array.isArray(parsed?.lines)) throw new Error(t('claudeBadFormat'));
  const translations = lines.map(() => '');
  const seen = new Set();
  for (const row of parsed.lines) {
    if (!wanted.has(row?.i) || seen.has(row.i) || typeof row.t !== 'string') continue;
    seen.add(row.i);
    translations[row.i] = row.t.trim();
  }
  const complete = items.every(x => translations[x.i]);
  return { translations, complete };
}

export { translateLines };

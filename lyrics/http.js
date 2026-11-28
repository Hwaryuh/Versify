// HTTP helpers shared by the lyrics sources.

// Finish the response and body read within 8 seconds. The body is read with readBody only when ok; otherwise it is null.
async function fetchWithTimeout(url, init, readBody) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, body: res.ok ? await readBody(res) : null };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitRetryAfter(res, maxSec) {
  const wait = Math.min(Number(res.headers?.get('retry-after')) || 1, maxSec);
  await new Promise(r => setTimeout(r, wait * 1000));
}

async function fetchJson(url, headers = {}, retry = true) {
  const { res, body } = await fetchWithTimeout(url, { headers }, r => r.json());
  if (res.ok) return body;
  if (res.status === 404) return null;
  if (res.status === 503 && retry) {
    await waitRetryAfter(res, 3);
    return fetchJson(url, headers, false);
  }
  throw new Error(`HTTP ${res.status}`);
}

export { fetchJson, fetchWithTimeout, waitRetryAfter };

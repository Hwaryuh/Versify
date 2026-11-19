// 가사 소스들이 같이 쓰는 HTTP 도우미

// 8초 안에 응답과 본문 읽기를 끝낸다. 본문은 성공(ok)일 때만 readBody 로 읽고, 아니면 null
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

// 서버가 바쁘면 retry-after 초만큼 (최대 maxSec) 기다린다. 헤더가 없으면 1초
async function waitRetryAfter(res, maxSec) {
  const wait = Math.min(Number(res.headers?.get('retry-after')) || 1, maxSec);
  await new Promise(r => setTimeout(r, wait * 1000));
}

export { fetchWithTimeout, waitRetryAfter };

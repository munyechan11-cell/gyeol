/**
 * SSR 검증 — "검색에 노출된다"는 주장이 실제로 성립하는지 확인한다.
 *
 * 가짜 API 를 띄우고 빌드된 Next 앱을 붙여, 크롤러가 받는 HTML 안에
 * 매장명·메뉴·구조화 데이터·hreflang 가 실제로 들어 있는지 본다.
 * (SPA 시절에는 이 자리에 빈 <div id="root"> 만 있었다.)
 *
 *   node scripts/verify-ssr.mjs
 */
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 이전 빌드 산출물과 ISR 캐시에 속지 않도록 매번 처음부터 빌드한다.
// (여기서 실제로 당한 적이 있다 — 이미 지운 레이아웃이 만든 HTML 이 캐시에서 계속 나왔다.)
const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
rmSync(new URL('../.next', import.meta.url), { recursive: true, force: true });
execFileSync('npx', ['next', 'build'], { cwd: APP_DIR, stdio: 'ignore' });

const STORE_ID = 'teststore';
const PAYLOAD = {
  store: {
    name: '결식당', fontTheme: 'editorial', tagline: '매일 아침 끓이는 국물',
    address: '서울시 마포구 어딘가 1길 2', phone: '0212345678',
    businessHours: { weekly: [{ closed: true }, { open: '11:00', close: '21:00' }] },
    temporarilyClosed: false, instagram: 'gyeol_test',
  },
  menu: [
    { name: '김치찌개', price: 9000, category: '찌개', imageUrl: '', description: '묵은지로 끓입니다' },
    { name: '된장찌개', price: 8500, category: '찌개', imageUrl: '', description: '' },
  ],
  reviews: [{ rating: 5, text: '국물이 진해요', name: '홍님', date: '2026-08-01', photoId: null }],
  gallery: [],
};

const API_PORT = 3401;
const APP_PORT = 3402;

const api = createServer((req, res) => {
  if (req.url?.startsWith(`/api/site/${STORE_ID}`)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(PAYLOAD));
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"store not found"}');
});
await new Promise((r) => api.listen(API_PORT, r));

// 포트가 이미 물려 있으면 옛 서버에 붙어 거짓 결과가 나온다. 먼저 확인하고 끊는다.
try {
  await fetch(`http://127.0.0.1:${APP_PORT}/`, { signal: AbortSignal.timeout(500) });
  throw new Error(`포트 ${APP_PORT} 를 이미 누가 쓰고 있다 — 이전 next-server 를 먼저 정리할 것`);
} catch (e) {
  if (e instanceof Error && e.message.startsWith('포트')) throw e;
  // 연결 거부 = 비어 있음. 정상.
}

const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  // 프로세스 그룹으로 띄워야 npx 래퍼가 아니라 next-server 까지 함께 정리된다.
  detached: true,
  env: {
    ...process.env,
    SITE_API_BASE: `http://127.0.0.1:${API_PORT}`,
    SITE_PUBLIC_ORIGIN: `http://127.0.0.1:${APP_PORT}`,
    SITE_APP_ORIGIN: 'https://app.example.test',
  },
  stdio: 'ignore',
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/ko/site/${STORE_ID}`);
      if (r.status < 500) return;
    } catch { /* 아직 부팅 중 */ }
    await wait(500);
  }
  throw new Error('next start 가 뜨지 않았다');
}

const checks = [];
const check = (name, cond, detail = '') => checks.push({ name, ok: !!cond, detail });

try {
  await ready();

  const res = await fetch(`http://127.0.0.1:${APP_PORT}/ko/site/${STORE_ID}`);
  const html = await res.text();

  check('200 응답', res.status === 200, `status=${res.status}`);
  check('매장명이 HTML 에 있다', html.includes('결식당'));
  check('메뉴 이름이 HTML 에 있다', html.includes('김치찌개') && html.includes('된장찌개'));
  check('메뉴 설명이 HTML 에 있다', html.includes('묵은지로 끓입니다'));
  check('가격이 한국어 형식으로 렌더된다', html.includes('₩ 9,000'));
  check('리뷰 본문이 HTML 에 있다', html.includes('국물이 진해요'));
  check('<title> 에 매장명이 들어간다', /<title>[^<]*결식당/.test(html));
  check('description 메타가 있다', /<meta name="description" content="매일 아침 끓이는 국물"/.test(html));
  check('canonical 이 현재 언어를 가리킨다', html.includes(`http://127.0.0.1:${APP_PORT}/ko/site/${STORE_ID}"`));
  // React 는 hreflang 을 hrefLang 으로 직렬화한다. HTML 속성은 대소문자를 가리지 않으므로
  // 크롤러에는 동일하게 읽힌다 — 검사도 대소문자 무시로 한다.
  const lower = html.toLowerCase();
  check('hreflang 4개 언어가 있다',
    ['ko', 'en', 'vi', 'zh'].every((l) => lower.includes(`hreflang="${l}"`)));
  check('og:title 이 있다', html.includes('property="og:title"'));
  check('JSON-LD Restaurant 구조화 데이터가 있다',
    html.includes('application/ld+json') && html.includes('"@type":"Restaurant"'));
  check('JSON-LD 에 평점이 들어간다', html.includes('"ratingValue":"5.0"'));
  check('선택한 글꼴 프리셋만 로드한다',
    html.includes('Playfair+Display') && !html.includes('Nanum+Pen+Script'));
  check('주문 링크가 앱 오리진으로 나간다',
    html.includes(`https://app.example.test/customer/store/${STORE_ID}`));
  check('lang 속성이 ko 다', /<html[^>]+lang="ko"/.test(html));

  // 영어판 — 같은 데이터, 다른 UI 라벨 · 다른 통화 표기
  const en = await (await fetch(`http://127.0.0.1:${APP_PORT}/en/site/${STORE_ID}`)).text();
  check('영어판은 lang="en"', /<html[^>]+lang="en"/.test(en));
  check('영어판 통화 표기는 공백 없이', en.includes('₩9,000') && !en.includes('₩ 9,000'));
  check('영어판도 매장명은 원문 그대로', en.includes('결식당'));
  check('영어판 UI 라벨이 영어다', en.includes('>Menu<'));
  check('영어판 canonical 이 /en 을 가리킨다',
    en.includes("/en/site/teststore\"") && !en.includes('localhost:3200'));

  // 기존 경로 호환
  const legacy = await fetch(`http://127.0.0.1:${APP_PORT}/site/${STORE_ID}`, {
    redirect: 'manual',
    headers: { 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' },
  });
  check('구 경로는 308 리다이렉트', legacy.status === 308, `status=${legacy.status}`);
  check('Accept-Language 에 맞는 언어판으로 보낸다',
    legacy.headers.get('location') === `/vi/site/${STORE_ID}`,
    String(legacy.headers.get('location')));

  // 없는 매장
  const missing = await fetch(`http://127.0.0.1:${APP_PORT}/ko/site/nosuchstore`);
  check('없는 매장은 404', missing.status === 404, `status=${missing.status}`);
} finally {
  try {
    process.kill(-app.pid, 'SIGKILL'); // 그룹 전체
  } catch {
    app.kill('SIGKILL');
  }
  api.close();
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.ok || !c.detail ? '' : `  (${c.detail})`}`);
  if (!c.ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} 통과`);
process.exit(failed ? 1 : 0);

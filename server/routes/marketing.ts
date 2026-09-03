import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { FieldValue, getDb, type CompatDb } from '../lib/db.js';
import { fetchWithTimeout } from '../lib/http.js';
import { langDirective } from '../lib/lang.js';
import { parseLooseJson } from '../lib/parsers.js';
import { callLLMText } from '../lib/reservation.js';
import { isValidStoreId } from '../lib/storeAuth.js';

const router = Router();

// 마케팅 생성 rate limit — 매장당 분당 10회. insight 와 버킷 분리 + storeId 기준이라
// (인증이 없는 엔드포인트라도) 한 매장이 유발할 수 있는 LLM 비용을 매장 단위로 묶는다.
const marketingBuckets = new Map<string, { count: number; resetAt: number }>();
const checkMarketingRate = (storeId: string): boolean => {
  const now = Date.now();
  if (marketingBuckets.size > 5000) marketingBuckets.clear();
  const b = marketingBuckets.get(storeId);
  if (!b || now > b.resetAt) { marketingBuckets.set(storeId, { count: 1, resetAt: now + 60_000 }); return true; }
  if (b.count >= 10) return false;
  b.count += 1;
  return true;
};


// ============================================================
// 마케팅 자율 에이전트 — 콘텐츠 생성 (TODO 7-2)
// 매장 마케팅 프로필(톤·타깃·키워드·금지어)을 반영해 게시물/응대 초안 텍스트를 생성한다.
// 서버는 '텍스트만' 만들고, 실제 초안 저장은 클라이언트가 addMarketingDraft(source:'agent')로
// 'draft' 상태로 넣는다 → 승인 게이트 유지. 금지어 포함 시 bannedHit 로 알려 승인 전에 검토하게 한다.
// ============================================================
router.post('/api/marketing/generate', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, channel, kind, topic, reviewText, rating, lang } = req.body ?? {};
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId required' });
    // 매장당 분당 10회 (storeId 기준 — 인증 없는 엔드포인트라도 매장 단위로 LLM 비용을 묶음)
    if (!checkMarketingRate(storeId)) {
      return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (분당 10회 제한)' });
    }
    const ch: string = ['instagram', 'naverPlace', 'general'].includes(channel) ? channel : 'instagram';
    const kd: string = kind === 'reply' ? 'reply' : 'post';

    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data() as any;
    const m = owner?.storeConfig?.marketingAgent ?? {};
    if (m.enabled !== true) return res.status(403).json({ error: 'marketing_disabled' });

    const storeName = owner?.restaurantName || '우리 가게';
    const industry = owner?.storeConfig?.industry || 'general';
    const channelLabel = ch === 'instagram' ? '인스타그램' : ch === 'naverPlace' ? '네이버플레이스' : '일반 SNS';
    const banned = String(m.bannedWords || '').split(',').map((s: string) => s.trim()).filter(Boolean);

    const toneLine = m.tone || '친근하고 따뜻하게';
    const targetLine = m.target || '동네 손님';
    const kwLine = m.keywords || '(없음)';
    const banLine = banned.length ? banned.join(', ') : '(없음)';
    // 평문 캡션 출력(JSON 강제 X) — LLM 이 자연스럽게 쓰게 해 품질↑, JSON 파싱 실패로 원문 노출되는 사고 방지.
    const sys = kd === 'post'
      ? `당신은 한국 동네 상권을 가장 잘 아는 SNS 마케팅 전문가입니다. 매장 "${storeName}"(업종: ${industry})의 ${channelLabel} 홍보 게시물 캡션을 씁니다.
목표: 읽는 사람이 "가보고 싶다 / 주문하고 싶다"는 마음이 들어 실제 방문·주문으로 이어지게.
[작성 구조]
1) 첫 줄: 시선을 확 끄는 후킹 한 문장 (질문·공감·한정·강렬한 감각 묘사 중 하나).
2) 본문: 메뉴·분위기·혜택을 오감(맛·향·식감·온도·소리)과 구체적 디테일로 생생하게. 2~4문장.
3) 마무리: 명확한 행동 유도(방문·주문·예약·저장) + 넛지 1가지(영업시간·한정 수량·위치 등).
4) 해시태그: 한 줄 띄우고 8~12개. 브랜드 + 동네/지역 + 업종/메뉴 + 상황(데이트·혼밥·점심 등) 섞어서.
[반영] 말투/톤: ${toneLine} · 타깃: ${targetLine} · 강조 키워드: ${kwLine}
[금지어(절대 사용 금지)]: ${banLine}
[규칙] 자연스러운 한국어. 이모지는 1~4개만 자연스럽게. 줄바꿈으로 읽기 쉽게. 과장·허위·의학적 효능 주장 금지.
출력은 게시물 캡션 본문만 — 설명·머리말·따옴표·코드펜스·JSON 절대 금지.`
      : `당신은 매장 "${storeName}"(업종: ${industry}) 사장님을 대신해 손님 리뷰/문의에 답하는 전문가입니다.
따뜻하고 진심 어리되 전문적인 답글을 쓰세요: 감사 인사 + 리뷰의 구체적 내용에 공감/언급 + (낮은 평점이면) 정중한 사과와 구체적 개선 약속 + 재방문 초대. 2~4문장.
변명·논쟁·복붙 느낌 금지. 말투/톤: ${toneLine}. 금지어(절대 금지): ${banLine}.
출력은 답글 본문만 — 설명·따옴표·코드펜스·JSON 절대 금지.`;
    let userMsg: string;
    if (kd === 'reply' && reviewText && String(reviewText).trim()) {
      // 리뷰 응대 초안 (7-5) — 실제 손님 리뷰에 답하는 초안
      const stars = Number(rating) >= 1 && Number(rating) <= 5 ? `${Math.round(Number(rating))}점` : '평점 없음';
      userMsg = `아래 손님 리뷰에 답하는 사장님 답글을 작성해 주세요.\n[별점] ${stars}\n[리뷰] ${String(reviewText).trim().slice(0, 600)}`;
    } else if (topic && String(topic).trim()) {
      userMsg = `이번 게시물 주제/소재: ${String(topic).trim().slice(0, 200)}`;
    } else {
      userMsg = kd === 'post' ? '오늘 올릴 만한, 매력적인 홍보 게시물 캡션을 만들어 주세요.' : '손님 리뷰/문의에 대한 정중한 응대 초안을 만들어 주세요.';
    }

    let text: string | null;
    try {
      text = await callLLMText(sys + langDirective(lang), userMsg, 900);
    } catch (e: any) {
      console.error('[marketing/generate] llm', e?.message);
      return res.status(502).json({ error: 'AI_CALL_FAILED' });
    }
    if (text === null) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });

    // 기대: 평문 캡션. 혹시 JSON/코드펜스로 감싸 오면 견고하게 content 추출(원문 JSON 노출 사고 방지).
    let content = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    if (content.startsWith('{')) {
      const parsed = parseLooseJson(content);
      if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
        let c = String(parsed.content).trim();
        const tags = Array.isArray(parsed.hashtags) ? parsed.hashtags.filter((tg: any) => typeof tg === 'string') : [];
        if (kd === 'post' && tags.length && !/#/.test(c)) {
          c += '\n\n' + tags.map((tg: string) => (tg.startsWith('#') ? tg : `#${tg.replace(/\s+/g, '')}`)).join(' ');
        }
        content = c;
      } else {
        // JSON.parse 실패(본문에 줄바꿈 등)해도 원문 JSON 노출 방지 — content 필드 값을 관대하게 추출
        const mm = content.match(/"content"\s*:\s*"([\s\S]*?)"\s*[,}]/);
        if (mm) content = mm[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, ' ').trim();
      }
    }
    // 모델이 캡션을 따옴표로 감싸는 경우 양끝 제거
    content = content.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim().slice(0, 2000);
    if (!content) return res.status(502).json({ error: 'AI_EMPTY' });
    // 제목 = 첫 의미있는 줄(해시태그/기호 제외)에서 추출, 목록 표시용.
    const firstLine = content.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || content;
    const title = firstLine.replace(/[#*_`>]/g, '').trim().slice(0, 40) || undefined;
    // 금지어 가드(7-7) — 자동 제거 대신 표시해 승인 전 사람이 검토하도록.
    const bannedHit = banned.filter((b: string) => content.includes(b));
    return res.json({ title, content, channel: ch, kind: kd, bannedHit });
  } catch (e: any) {
    console.error('[marketing/generate]', e?.message);
    res.status(500).json({ error: e?.message ?? 'generate failed' });
  }
});

// ============================================================
// 마케팅 채널 발행 (TODO 7-4) — Zernio 소셜 발행 대행 API로 인스타그램 게시.
// 매장별 Zernio 계정(storeConfig.publishing.instagramAccountId)으로 발행. ZERNIO_API_KEY 는 결 플랫폼 공용.
// 인스타는 미디어(이미지) 필수 — imageUrl(공개 URL) 없으면 거부. 승인된 초안만 클라이언트가 호출.
// ============================================================
// 결 요금제(향후): 채널 무료 1개 / ₩10,000=3개 / 그 이상 구독제 · 자동홍보 프로 ₩25,000(3개)·맥스 ₩40,000(무제한).
// 베타 기간에는 전부 무료 — 과금 게이트는 MARKETING_BILLING='on' 일 때만 적용(기본 off).
const MARKETING_BILLING_ENFORCED = process.env.MARKETING_BILLING === 'on';
const PLAN_PRO_PRICE_KRW = 10000;
const FREE_CHANNEL_LIMIT = 1;
const SUPPORTED_PLATFORMS = ['instagram', 'googlebusiness'];
// 매장에 연결된 채널 목록 — 신규 channels 맵 + (구) 단일 인스타 필드 호환.
function connectedChannels(owner: any): Array<{ platform: string; accountId: string; username?: string }> {
  const pub = owner?.storeConfig?.publishing ?? {};
  const out: Array<{ platform: string; accountId: string; username?: string }> = [];
  const ch = pub.channels && typeof pub.channels === 'object' ? pub.channels : {};
  for (const [platform, v] of Object.entries(ch)) {
    const acc = (v as any)?.accountId;
    if (acc) out.push({ platform, accountId: String(acc), username: (v as any)?.username });
  }
  // 구 단일 인스타 호환 (channels.instagram 없을 때만)
  if (pub.instagramAccountId && !(ch as any).instagram) out.push({ platform: 'instagram', accountId: String(pub.instagramAccountId), username: pub.instagramUsername });
  return out;
}

type MediaItem = { type: 'image' | 'video'; url: string };
async function zernioPublish(content: string, mediaItems: MediaItem[], platforms: Array<{ platform: string; accountId: string }>): Promise<{ ok: boolean; error?: string; data?: any; status?: number }> {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) return { ok: false, error: 'ZERNIO_NOT_CONFIGURED' };
  if (!platforms.length) return { ok: false, error: 'no_channels' };
  if (!mediaItems.length) return { ok: false, error: 'image_required' };
  const r = await fetchWithTimeout('https://zernio.com/api/v1/posts', {
    method: 'POST',
    // x-request-id: 매 호출 새 UUID — ~5분 재시도 멱등성. 24h 내 동일 콘텐츠 재발행은 Zernio 가 409.
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-request-id': randomUUID() },
    body: JSON.stringify({
      content: content.slice(0, 2200), // 인스타 캡션 최대 2200자
      // 1개=단일 / 2~10개=캐러셀(자동, 별도 flag 불필요) / [{type:'video'}]=릴스(세로 9:16 자동 릴스)
      mediaItems,
      platforms, // [{platform:'instagram',accountId}, ...] — 한 번에 여러 채널 발행
      publishNow: true,
    }),
  }, 30000);
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data?.error || data?.message || `zernio ${r.status}`, data, status: r.status };
  return { ok: true, data };
}

router.post('/api/marketing/publish', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, content, imageUrl, photoId, photoIds, videoUrl, platforms } = req.body ?? {};
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId required' });
    if (!checkMarketingRate(storeId)) return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (분당 10회 제한)' });
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content_required' });
    if (!process.env.ZERNIO_API_KEY) return res.status(503).json({ error: 'ZERNIO_NOT_CONFIGURED' });
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data() as any;
    let targets = connectedChannels(owner);
    // 요청에 특정 채널만 지정되면 그것만 (연결된 것 중에서)
    if (Array.isArray(platforms) && platforms.length) {
      const want = new Set(platforms.map((p: any) => String(p)));
      targets = targets.filter((t) => want.has(t.platform));
    }
    if (!targets.length) return res.status(400).json({ error: 'no_channel_connected' });
    // 미디어 구성: 영상(릴스) > 사진 여러 장(캐러셀) > 사진 1장 / imageUrl(호환).
    // photoId/photoIds 는 우리 서버가 그 매장 사진을 공개 이미지로 서빙하는 URL(base64 → 공개 URL).
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const toImgUrl = (id: string) => `${proto}://${req.get('host')}/api/marketing/image/${encodeURIComponent(id)}?storeId=${encodeURIComponent(storeId)}`;
    let mediaItems: MediaItem[] = [];
    if (videoUrl && /^https:\/\/.+/i.test(String(videoUrl))) {
      mediaItems = [{ type: 'video', url: String(videoUrl) }]; // 릴스 — 공개 HTTPS 영상 URL (Zernio 가 직접 fetch)
    } else if (Array.isArray(photoIds) && photoIds.length) {
      const ids = [...new Set(photoIds.filter((id: any) => typeof id === 'string' && isValidStoreId(id)))].slice(0, 10); // 중복 제거 후 인스타 캐러셀 최대 10장
      mediaItems = ids.map((id: string) => ({ type: 'image' as const, url: toImgUrl(id) }));
    } else if (photoId && typeof photoId === 'string' && isValidStoreId(photoId)) {
      mediaItems = [{ type: 'image', url: toImgUrl(photoId) }]; // 단일(기존 호환)
    } else if (imageUrl && /^https:\/\/.+/i.test(String(imageUrl))) {
      mediaItems = [{ type: 'image', url: String(imageUrl) }]; // 단일 URL(기존 호환, 공개 HTTPS만)
    }
    if (!mediaItems.length) return res.status(400).json({ error: 'image_required' });
    // 캐러셀(여러 장)·릴스(영상)는 인스타만 — 구글 비즈니스는 1장·영상 미지원.
    const isVideo = mediaItems.some((m) => m.type === 'video');
    if (isVideo || mediaItems.length > 1) targets = targets.filter((t) => t.platform === 'instagram');
    if (!targets.length) return res.status(400).json({ error: isVideo ? 'reel_needs_instagram' : 'carousel_needs_instagram' });
    const r = await zernioPublish(String(content), mediaItems, targets.map((t) => ({ platform: t.platform, accountId: t.accountId })));
    if (!r.ok) {
      const code = r.error === 'ZERNIO_NOT_CONFIGURED' ? 503 : r.status === 409 ? 409 : 502;
      return res.status(code).json({ error: r.status === 409 ? 'duplicate' : (r.error || 'publish_failed') });
    }
    return res.json({ ok: true, result: r.data, channels: targets.map((t) => t.platform) });
  } catch (e: any) { console.error('[marketing/publish]', e?.message); res.status(500).json({ error: e?.message ?? 'publish failed' }); }
});

// 매장 사진(photos.imageData base64)을 공개 이미지 바이트로 서빙 — Zernio 가 인스타 발행 시 이 URL 을 fetch.
// (base64 data URL 은 Zernio 가 못 가져오므로, 우리 서버가 실제 이미지로 변환해 공개 URL 제공.)
router.get('/api/marketing/image/:photoId', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).end();
    const photoId = String(req.params.photoId || '');
    const storeId = String(req.query.storeId || '');
    if (!isValidStoreId(photoId) || !isValidStoreId(storeId)) return res.status(400).end();
    const snap = await db.collection('photos').doc(photoId).get();
    if (!snap.exists) return res.status(404).end();
    const pdata = snap.data() as any;
    if (pdata?.storeId !== storeId) return res.status(404).end(); // 매장 경계 강제 — 타매장 사진 IDOR 차단
    const img = pdata?.imageData;
    if (typeof img !== 'string') return res.status(404).end();
    const m = img.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(m[2], 'base64'));
  } catch (e: any) { console.error('[marketing/image]', e?.message); res.status(500).end(); }
});


// ============================================================
// 소셜 채널 셀프 연결 (TODO 7-4) — 각 사장님이 결 안에서 자기 채널(인스타·구글 비즈니스)을 직접 연결.
//  1) connect-url: 매장 전용 Zernio 프로필 확보 → OAuth authUrl 반환(사장님이 자기 계정 로그인·허용)
//                   2번째 채널부터는 결 Pro 요금제(월 ₩10,000) 필요 — free 면 402 upgrade_required
//  2) connect-finish: OAuth 후 그 프로필의 해당 채널 계정 id 를 storeConfig.publishing.channels 에 자동 저장
//  3) disconnect: 연결 해제(우리 쪽 매핑 제거)
// 사장님은 Zernio 대시보드/계정id 를 볼 필요 없음.
// ============================================================
async function zernioApi(method: string, path: string, body?: any): Promise<{ ok: boolean; status: number; data: any }> {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) return { ok: false, status: 503, data: { error: 'ZERNIO_NOT_CONFIGURED' } };
  const r = await fetchWithTimeout(`https://zernio.com/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 30000);
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
// storeConfig.publishing.* 만 안전하게 갱신 (Admin set merge — 다른 storeConfig 필드 보존; 중첩 map 은 deep-merge)
async function savePublishing(db: CompatDb, storeId: string, patch: Record<string, any>) {
  await db.collection('users').doc(storeId).set({ storeConfig: { publishing: patch } }, { merge: true });
}
// Zernio /accounts 의 platform 문자열이 우리 platform 키와 같은 채널인지 (구글은 표기 변형 흡수)
function zernioAccountMatches(accPlatform: string, ours: string): boolean {
  const p = String(accPlatform || '').toLowerCase().replace(/[_-]/g, '');
  if (ours === 'instagram') return p === 'instagram';
  if (ours === 'googlebusiness') return p === 'googlebusiness' || p === 'google' || p === 'gmb' || p === 'googlemybusiness';
  return p === ours;
}

router.post('/api/marketing/connect-url', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, platform, redirectUrl } = req.body ?? {};
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId required' });
    if (!SUPPORTED_PLATFORMS.includes(String(platform))) return res.status(400).json({ error: 'unsupported_platform' });
    if (!checkMarketingRate(storeId)) return res.status(429).json({ error: '잠시 후 다시 시도해 주세요.' });
    if (!process.env.ZERNIO_API_KEY) return res.status(503).json({ error: 'ZERNIO_NOT_CONFIGURED' });
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data() as any;
    // 요금제 게이트(베타엔 off): 이미 연결된 다른 채널이 있고(=2번째 채널) free 면 Pro 필요
    const plan = owner?.storeConfig?.plan === 'pro' ? 'pro' : 'free';
    const existing = connectedChannels(owner);
    const already = existing.some((c) => c.platform === platform);
    if (MARKETING_BILLING_ENFORCED && !already && existing.length >= FREE_CHANNEL_LIMIT && plan !== 'pro') {
      return res.status(402).json({ error: 'upgrade_required', plan, priceKrw: PLAN_PRO_PRICE_KRW, freeLimit: FREE_CHANNEL_LIMIT });
    }
    let profileId = owner?.storeConfig?.publishing?.zernioProfileId;
    if (!profileId) {
      // 매장 전용 프로필 생성 (각 가게의 소셜 계정을 묶는 단위)
      const created = await zernioApi('POST', '/profiles', { name: String(owner?.restaurantName || storeId).slice(0, 60), description: `gyeol:${storeId}` });
      profileId = created.data?._id || created.data?.profile?._id || created.data?.id;
      if (!created.ok || !profileId) return res.status(502).json({ error: 'profile_create_failed' });
      await savePublishing(db, storeId, { zernioProfileId: profileId });
    }
    // redirect_url: OAuth 완료 후 Zernio 대시보드(로그인 벽) 대신 우리 앱으로 복귀 → ?connected={platform}&accountId=...&username=...
    let connectPath = `/connect/${platform}?profileId=${encodeURIComponent(profileId)}`;
    if (redirectUrl && /^https:\/\/.+/i.test(String(redirectUrl)) && String(redirectUrl).length < 500) {
      connectPath += `&redirect_url=${encodeURIComponent(String(redirectUrl))}`;
    }
    const conn = await zernioApi('GET', connectPath);
    const authUrl = conn.data?.authUrl || conn.data?.url;
    if (!conn.ok || !authUrl) return res.status(502).json({ error: 'connect_url_failed' });
    return res.json({ authUrl });
  } catch (e: any) { console.error('[connect-url]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

router.post('/api/marketing/connect-finish', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, platform } = req.body ?? {};
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId required' });
    if (!SUPPORTED_PLATFORMS.includes(String(platform))) return res.status(400).json({ error: 'unsupported_platform' });
    if (!process.env.ZERNIO_API_KEY) return res.status(503).json({ error: 'ZERNIO_NOT_CONFIGURED' });
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data() as any;
    const profileId = owner?.storeConfig?.publishing?.zernioProfileId;
    if (!profileId) return res.status(400).json({ error: 'no_profile' });
    const list = await zernioApi('GET', '/accounts');
    if (!list.ok) return res.status(502).json({ error: 'accounts_failed' });
    const accounts: any[] = Array.isArray(list.data?.accounts) ? list.data.accounts : [];
    const acc = accounts
      .filter((a) => zernioAccountMatches(a.platform, String(platform)) && (a.profileId?._id === profileId || a.profileId === profileId))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (!acc) return res.json({ connected: false }); // 아직 OAuth 미완료
    const username = acc?.metadata?.profileData?.username || acc?.metadata?.profileData?.name || acc?.displayName || '';
    await savePublishing(db, storeId, { channels: { [String(platform)]: { accountId: acc._id, username } } });
    return res.json({ connected: true, platform, username, accountId: acc._id });
  } catch (e: any) { console.error('[connect-finish]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

router.post('/api/marketing/disconnect', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, platform } = req.body ?? {};
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId required' });
    if (!SUPPORTED_PLATFORMS.includes(String(platform))) return res.status(400).json({ error: 'unsupported_platform' });
    const del = FieldValue.delete();
    const patch: Record<string, any> = { channels: { [String(platform)]: del } };
    // 인스타는 구 단일 필드도 같이 제거(호환 fallback 이 남지 않도록)
    if (platform === 'instagram') { patch.instagramAccountId = del; patch.instagramUsername = del; }
    await db.collection('users').doc(storeId).set({ storeConfig: { publishing: patch } }, { merge: true });
    return res.json({ ok: true });
  } catch (e: any) { console.error('[disconnect]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

export default router;

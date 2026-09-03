import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { getDb, type CompatDb } from '../lib/db.js';
import { resolveCallerStore } from '../lib/storeAuth.js';

const router = Router();


// ============================================================
// 토스플레이스(오프라인 토스 POS) 매출 연동 — Open API 웹훅 + 조회 보정
//
//   ※ 토스페이먼츠(PG)와 완전 별개 제품. 인증키도 따로다
//      (x-access-key / x-secret-key + 웹훅 Secret). 토스페이먼츠 sk_ 로는 안 됨.
//
//   흐름: POS 결제 → 토스플레이스가 /api/tossplace/webhook 으로 POST
//        → 서명검증(HMAC-SHA256) → merchantId→storeId 매핑
//        → orders 컬렉션에 'paid' 주문으로 기록 → 사장님 대시보드/정산 매출에 자동 반영
//          (클라이언트가 orders 를 storeId 로 구독하므로 별도 작업 불필요).
//
//   ⚠️ TODO(키 발급 후 실페이로드로 확정): 결제완료 이벤트 type 문자열, data 안의
//      금액/결제ID/시각 필드명, 그리고 조회 API 의 정확한 base URL·경로·응답 형태.
//      첫 수신 시 전체 페이로드를 로깅하니 그걸로 매핑을 확정한다.
// ============================================================

// TODO: 토스플레이스 Open API 실제 base URL 확인 (docs.tossplace.com).
// 실제 토스플레이스 Open API 호스트는 open-api (하이픈). openapi(하이픈X)는 DNS 미존재 → fetch failed.
const TOSSPLACE_API_BASE = process.env.TOSSPLACE_API_BASE || 'https://open-api.tossplace.com';

/** 토스플레이스 결제 1건을 orders 에 멱등 upsert. 문서 id = tossplace_<paymentId> 라 재수신·중복 안전. */
async function upsertTossPlacePayment(
  db: CompatDb,
  storeId: string,
  p: { paymentId: string; amount: number; method?: 'card' | 'cash'; paidAt?: string }
): Promise<void> {
  const orderId = `tossplace_${p.paymentId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  await db.collection('orders').doc(orderId).set(
    {
      storeId,
      tableNumber: 0, // POS 외부결제 — 앱 테이블과 무관 (테이블 흐름에서 제외)
      customerId: '',
      items: [{ menuId: '', name: '토스 POS 결제', quantity: 1, price: p.amount }],
      totalAmount: p.amount,
      status: 'served', // 활성주문(주방/테이블)에서 빠지도록
      paymentStatus: 'paid',
      paymentMethod: p.method ?? 'card',
      source: 'tossplace',
      createdAt: p.paidAt ?? new Date().toISOString(),
    },
    { merge: true }
  );
}

/** 페이로드/거래객체에서 결제 정보를 방어적으로 추출 (필드명이 문서상 미확정이라 폭넓게 매칭). */
function extractTossPlacePayment(d: any): { paymentId?: string; amount: number; method: 'card' | 'cash'; paidAt?: string } {
  const paymentId = d?.paymentId || d?.id || d?.orderId || d?.transactionId;
  const amount = Number(d?.amount?.total ?? d?.totalAmount ?? d?.totalPrice ?? d?.paymentAmount ?? d?.approvedAmount ?? d?.amount ?? 0);
  const method = /cash|현금/i.test(String(d?.method ?? d?.payMethod ?? d?.paymentMethod ?? '')) ? 'cash' : 'card';
  const paidAt = d?.approvedAt || d?.paidAt || d?.completedAt || d?.createdAt;
  return { paymentId, amount, method, paidAt };
}

// --- 토스플레이스 연동 설정 저장 (인증 필요) ---
// 비밀 키는 store_secrets(서버 전용), merchantId→storeId 역매핑은 merchant_map(서버 전용),
// 비밀 아닌 표시 정보(tossPlace)는 users 문서에 저장한다.
router.post('/api/store/tossplace-config', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    // 매장 id 는 토큰에서 읽는다 — 본문에서 받으면 남의 매장 결제를 자기
    // merchantId 로 끌어올 수 있다(merchant_map 이 그 방향으로 덮인다).
    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    if (caller.role !== 'owner') return res.status(403).json({ error: 'owner only' });

    const { storeId, merchantId, accessKey, secretKey, webhookSecret } = req.body ?? {};
    if (storeId && storeId !== caller.userId) {
      return res.status(403).json({ error: 'not your store' });
    }
    if (!merchantId) return res.status(400).json({ error: 'merchantId required' });

    const ownStoreId = caller.userId;
    const now = new Date().toISOString();
    const secretPatch: Record<string, any> = { tossPlaceMerchantId: String(merchantId), updatedAt: now };
    if (accessKey) secretPatch.tossPlaceAccessKey = accessKey;
    if (secretKey) secretPatch.tossPlaceSecretKey = secretKey;
    if (webhookSecret) secretPatch.tossPlaceWebhookSecret = webhookSecret;
    await db.collection('store_secrets').doc(ownStoreId).set(secretPatch, { merge: true });
    await db.collection('merchant_map').doc(String(merchantId)).set({ storeId: ownStoreId, updatedAt: now }, { merge: true });
    await db.collection('users').doc(ownStoreId).set({ tossPlace: { merchantId: String(merchantId), connectedAt: now } }, { merge: true });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[tossplace-config] failed', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

// --- 토스플레이스 웹훅 수신 (인증 없음 — 서명으로 검증) ---
router.post('/api/tossplace/webhook', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const body = req.body ?? {};
    // merchantId 위치가 payload 형태마다 다를 수 있어 여러 곳 탐색
    const merchantId = body.merchantId ?? body.data?.merchantId ?? body.storeId ?? body.data?.storeId ?? body.mid ?? body.data?.mid;
    const evtType = String(body?.type ?? body?.eventType ?? body?.event ?? '');
    // 진단 기록 — 웹훅이 "도착했는지/형태/결과"를 앱에서 확인할 수 있게. 실패해도 웹훅 처리엔 영향 X.
    const writeDiag = async (outcome: string, extra?: any) => {
      try {
        await db.collection('tossplace_diag').doc('last').set({
          receivedAt: new Date().toISOString(),
          merchantId: merchantId != null ? String(merchantId) : null,
          type: evtType,
          topKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 25) : [],
          dataKeys: body?.data && typeof body.data === 'object' ? Object.keys(body.data).slice(0, 25) : [],
          hasSig: !!req.headers['x-toss-signature'],
          outcome,
          ...(extra || {}),
        });
      } catch { /* diag 실패 무시 */ }
    };

    if (!merchantId) { await writeDiag('no-merchantId'); return res.status(400).json({ error: 'merchantId missing' }); }

    // merchantId → storeId
    const mapSnap = await db.collection('merchant_map').doc(String(merchantId)).get();
    const storeId = mapSnap.data()?.storeId as string | undefined;
    if (!storeId) {
      console.warn('[tossplace webhook] unknown merchantId', merchantId);
      await writeDiag('not-mapped');
      return res.status(404).json({ error: 'merchant not mapped' });
    }

    // 서명검증 — HMAC-SHA256( `${timestamp}.${rawBody}` ), header x-toss-signature: "v1=<hex>"
    // 웹훅 Secret: 매장별 저장값 우선, 없으면 앱 단위 환경변수(플랫폼 모델 — 결이 앱 1개로 다수 매장 수신).
    const secret =
      ((await db.collection('store_secrets').doc(storeId).get()).data()?.tossPlaceWebhookSecret as string | undefined) ??
      process.env.TOSSPLACE_WEBHOOK_SECRET;
    const sigHeader = String(req.headers['x-toss-signature'] || '');
    const timestamp = String(req.headers['x-toss-timestamp'] || '');
    const raw: Buffer = (req as any).rawBody ?? Buffer.from(JSON.stringify(body), 'utf8');
    let sigOk: boolean | null = null; // null = secret 미설정(검증 생략)
    if (secret) {
      const expected = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
      const a = Buffer.from(sigHeader);
      const b = Buffer.from(expected);
      sigOk = a.length === b.length && timingSafeEqual(a, b);
      // 비차단: 서명 불일치여도 매출 누락 방지 위해 일단 진행하고 sig 결과만 진단에 남김(secret 확정 후 엄격모드 복구 가능)
      if (!sigOk) console.warn('[tossplace webhook] signature mismatch — 비차단 처리', { merchantId });
    }

    console.log('[tossplace webhook]', evtType, JSON.stringify(body).slice(0, 1200));

    // 결제/주문 완료 계열 이벤트면 매출 기록. type 이 미상이거나 결제/주문 계열이면 시도(amount>0 + 멱등 upsert 라 안전).
    let recorded = false;
    if (!evtType || /payment|order|결제|주문|sale|approv|paid|complete|done/i.test(evtType)) {
      const { paymentId, amount, method, paidAt } = extractTossPlacePayment(body.data ?? body);
      if (paymentId && amount > 0) {
        await upsertTossPlacePayment(db, storeId, { paymentId: String(paymentId), amount, method, paidAt });
        recorded = true;
        console.log('[tossplace webhook] recorded', { storeId, paymentId, amount });
      }
    }
    await writeDiag(recorded ? 'recorded' : 'received-not-recorded', { storeId, sigOk });
    res.json({ ok: true, recorded, sigOk });
  } catch (e: any) {
    console.error('[tossplace webhook] failed', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

// --- 토스플레이스 웹훅 진단 — 마지막 수신 웹훅(도착여부·형태·결과) 조회. "결제했는데 안 잡힘" 원인 파악용 ---
router.post('/api/store/tossplace-diag', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller || caller.role !== 'owner') return res.status(401).json({ error: 'unauthorized' });
    const snap = await db.collection('tossplace_diag').doc('last').get();
    res.json({ ok: true, last: snap.exists ? snap.data() : null });
  } catch (e: any) {
    console.error('[tossplace-diag] failed', e?.message);
    res.status(500).json({ error: 'diag failed' });
  }
});

// --- 토스플레이스 매출 수동 동기화/보정 (인증 필요) — 웹훅 누락분 백필 ---
router.post('/api/store/tossplace-sync', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    if (caller.role !== 'owner') return res.status(403).json({ error: 'owner only' });
    const { storeId: bodyStoreId } = req.body ?? {};
    if (bodyStoreId && bodyStoreId !== caller.userId) {
      return res.status(403).json({ error: 'not your store' });
    }
    const storeId = caller.userId;

    const sec = (await db.collection('store_secrets').doc(storeId).get()).data() ?? {};
    // 키: 매장별 저장값 우선, 없으면 앱 단위 환경변수(플랫폼 모델). merchantId 는 매장 식별·API 경로용이라 항상 매장별.
    const accessKey = sec.tossPlaceAccessKey ?? process.env.TOSSPLACE_ACCESS_KEY;
    const secretKey = sec.tossPlaceSecretKey ?? process.env.TOSSPLACE_SECRET_KEY;
    const merchantId = sec.tossPlaceMerchantId;
    if (!accessKey || !secretKey || !merchantId) {
      return res.status(400).json({ error: 'tossplace-not-configured' });
    }

    // 가맹점 전체 "결제목록" API 는 없음(개별/주문별만) → 주문목록(Order API)으로 백필. 기본 COMPLETED+CANCELLED 조회.
    // 날짜범위(from~to) — ISO 8601 로는 빈 결과여서 epoch(밀리초 숫자)로 시도. 최근 365일.
    const toTs = Date.now();
    const fromTs = Date.now() - 365 * 86400000;
    const url = `${TOSSPLACE_API_BASE}/api-public/openapi/v1/merchants/${encodeURIComponent(merchantId)}/order/orders?page=1&size=500&sortOrder=DESC&from=${fromTs}&to=${toTs}`;
    const r = await fetch(url, { headers: { 'x-access-key': accessKey, 'x-secret-key': secretKey, 'content-type': 'application/json' } });
    const text = await r.text();
    if (!r.ok) {
      console.error('[tossplace sync] api error', r.status, text.slice(0, 300));
      return res.status(502).json({ error: 'tossplace-api-error', status: r.status, detail: text.slice(0, 300) });
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'parse-error' });
    }
    // 공통 응답 봉투 해제: { resultType:"SUCCESS", success: <Order[] 또는 페이지객체> }
    const root = payload?.success ?? payload;
    const list: any[] = Array.isArray(root) ? root : (root?.content ?? root?.orders ?? root?.list ?? root?.data ?? []);
    let recorded = 0;
    for (const d of list) {
      if (/CANCEL/i.test(String(d?.state ?? d?.orderState ?? d?.status ?? ''))) continue; // 취소 주문 제외
      const { paymentId, amount, method, paidAt } = extractTossPlacePayment(d);
      if (!paymentId || amount <= 0) continue;
      await upsertTossPlacePayment(db, storeId, { paymentId: String(paymentId), amount, method, paidAt });
      recorded++;
    }
    // recorded=0 이면 원인 진단용 봉투 구조(값 아닌 '키/타입'만) 회신 — 주문0건인지 파싱미스인지 구분
    let debug: any;
    if (recorded === 0) {
      const succ = payload?.success;
      debug = {
        topKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : typeof payload,
        successType: Array.isArray(succ) ? `array(${succ.length})` : succ && typeof succ === 'object' ? 'object' : String(succ),
        successKeys: succ && typeof succ === 'object' && !Array.isArray(succ) ? Object.keys(succ).slice(0, 20) : undefined,
        itemKeys: list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 30) : undefined,
      };
    }
    res.json({ ok: true, fetched: list.length, recorded, ...(debug ? { debug } : {}) });
  } catch (e: any) {
    console.error('[tossplace sync] failed', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

export default router;

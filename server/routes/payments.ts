import { Router } from 'express';

import { getDb } from '../lib/db.js';
import { resolveCallerStore } from '../lib/storeAuth.js';

const router = Router();


// --- TOSS PAYMENTS CONFIRM API ---
router.post('/api/payment/confirm', async (req, res) => {
  const { paymentKey, orderId, amount, storeId } = req.body;

  // 멀티테넌트 — 매장별 시크릿 키 우선(각 매장 토스로 정산), 없으면 서버 환경변수 폴백(테스트용)
  let secretKey = process.env.TOSS_SECRET_KEY;
  if (storeId) {
    try {
      const db = getDb();
      if (db) {
        const snap = await db.collection('store_secrets').doc(storeId).get();
        const k = snap.data()?.tossSecretKey;
        if (typeof k === 'string' && k) secretKey = k;
      }
    } catch (e: any) {
      console.warn('[toss] store secret lookup failed', e?.message);
    }
  }

  if (!secretKey) {
    return res.status(500).json({ error: 'Toss Secret Key not configured.' });
  }

  try {
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(secretKey + ':').toString('base64')}`
      },
      body: JSON.stringify({ paymentKey, orderId, amount })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[Toss Confirm Error]', data);
      return res.status(response.status).json({ error: data.message || 'Payment confirmation failed' });
    }

    console.log(`[Toss] Payment confirmed: ${orderId}, amount: ${amount}`);
    res.json({ success: true, payment: data });
  } catch (error: any) {
    console.error('[Toss Error]', error.message);
    res.status(500).json({ error: '결제 확인에 실패했어요. 잠시 후 다시 시도해 주세요.' }); // 내부 오류 메시지 비노출

  }
});

// --- 매장 토스 시크릿 키 저장 (멀티테넌트) ---
// store_secrets 에는 RLS 정책이 하나도 없다 = 클라이언트 접근 0. service_role 만 닿는다.
// 사장님이 브랜드설정에서 시크릿 키를 입력하면 이 엔드포인트로 안전하게 저장된다.
//
// 예전에는 "로그인했는가"만 확인하고 storeId 는 본문에서 받아 그대로 썼다.
// 즉 로그인한 아무나 남의 매장 정산 계좌를 자기 키로 바꿔칠 수 있었다.
// 이제 매장 id 를 토큰에서 읽으므로 본문 값은 확인용으로만 쓴다.
router.post('/api/store/toss-secret', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    // 정산 키는 사장 본인만 — 직원은 매장에 속하지만 이건 다른 권한이다.
    if (caller.role !== 'owner') return res.status(403).json({ error: 'owner only' });

    const { storeId, secretKey } = req.body ?? {};
    if (storeId && storeId !== caller.userId) {
      return res.status(403).json({ error: 'not your store' });
    }
    if (!secretKey || typeof secretKey !== 'string') {
      return res.status(400).json({ error: 'secretKey required' });
    }
    await db
      .collection('store_secrets')
      .doc(caller.userId)
      .set({ tossSecretKey: secretKey, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[toss-secret] failed', e?.message);
    res.status(500).json({ error: e?.message });
  }
});

export default router;

import { Router } from 'express';

import { sendPushToOwner } from '../lib/push.js';
import { resolveCallerStore } from '../lib/storeAuth.js';

const router = Router();


/**
 * 발송 트리거.
 *
 * **왜 "본인 매장만" 으로 못 잠그는가.** 이 푸시는 대부분 손님이 일으킨다 —
 * 주문·결제 요청·쿠폰 요청은 손님이 하고 알림은 사장님이 받는다. 직원 가입도
 * 아직 그 매장 소속이 아닌 사람이 낸다. 그래서 "요청자의 매장 == 대상 매장"을
 * 요구하면 정상 흐름이 전부 막힌다.
 *
 * 대신 세 겹으로 좁힌다:
 *   1) 유효한 세션 필수 — 세션은 이제 OTP 나 소셜 검증을 통과해야만 생긴다.
 *      (예전에는 익명 토큰이면 통과였다. 아무나 받을 수 있는 토큰이었다.)
 *   2) 사용자당 분당 20회 — 한 계정이 여러 매장을 도배하는 걸 막는다.
 *   3) test 종류만은 그 매장 사람만 — 사장님이 자기 설정 화면에서 쓰는 것이라
 *      손님이 보낼 이유가 없다.
 *
 * 남는 것: 인증된 사용자가 관계없는 매장에 정상 종류의 알림을 몇 개 보낼 수는
 * 있다. 완전히 막으려면 "이 손님이 이 매장에 지금 주문/방문이 있는가"를 확인해야
 * 하고, 그건 종류마다 다른 조회라 별도 작업이다.
 *
 * IP 별 분당 60회 제한은 그대로 둔다.
 */
const makeLimiter = (perMinute: number) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (b.count >= perMinute) return false;
    b.count += 1;
    return true;
  };
};
const checkPushRate = makeLimiter(60);
const checkUserRate = makeLimiter(20);

router.post('/api/push/send-to-owner', async (req, res) => {
  try {
    // 1) Rate limit
    const ip = String(req.ip || 'unknown').split(',')[0].trim();
    if (!checkPushRate(ip)) {
      return res.status(429).json({ error: '요청이 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    }

    // 2) 세션 검증 + 요청자의 매장 확인
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'Authorization header required' });
    }
    const caller = await resolveCallerStore(req.headers.authorization);
    if (!caller) return res.status(401).json({ error: 'invalid token' });

    if (!checkUserRate(caller.userId)) {
      return res.status(429).json({ error: '요청이 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    }

    // 3) 입력 검증
    const { storeId, kind, title, body, focusUrl, tag } = req.body ?? {};
    if (!storeId || !kind || !title) {
      return res.status(400).json({ error: 'storeId, kind, title required' });
    }
    const validKinds = ['new-order', 'payment-request', 'staff-join', 'coupon-request', 'test'];
    if (!validKinds.includes(kind)) {
      return res.status(400).json({ error: 'invalid kind' });
    }
    // 테스트 발송은 그 매장 사람만 — 손님이 보낼 이유가 없다.
    if (kind === 'test' && caller.storeId !== storeId) {
      return res.status(403).json({ error: 'not your store' });
    }

    const r = await sendPushToOwner({ storeId, kind, title, body: body ?? '', focusUrl, tag });
    res.json(r);
  } catch (e: any) {
    console.error('[push] endpoint error', e?.message);
    res.status(500).json({ error: e?.message ?? 'push send failed' });
  }
});

export default router;

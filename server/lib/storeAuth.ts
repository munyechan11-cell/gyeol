

import { getDb, getSupabaseAdmin } from './db.js';

// 문서 ID 로 안전한 storeId 인지 — 빈값·슬래시·예약어(__x__)·과도한 길이 차단.
// (잘못된 id 를 쿼리에 넘기면 드라이버가 throw → 내부 에러 500 노출되므로 미리 400 으로 거른다.)
export function isValidStoreId(id: any): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/') && !/^__.*__$/.test(id);
}
// 공유키 인증 — 미설정 시 503(실수로 공개 방지). 음성채널 webhook 은 x-ai-key 헤더로 호출.
export function checkAiReservationAuth(req: any, res: any): boolean {
  const key = process.env.AI_RESERVATION_KEY;
  if (!key) { res.status(503).json({ error: 'AI_RESERVATION_NOT_CONFIGURED' }); return false; }
  if (req.headers['x-ai-key'] !== key) { res.status(401).json({ error: 'invalid key' }); return false; }
  return true;
}

/**
 * 요청자의 매장 — **토큰에서** 읽는다.
 *
 * 예전에는 이게 불가능했다. 결의 user.id 와 Firebase auth 의 uid 가 서로 다른
 * 값이어서, 서버는 "이 토큰의 주인이 어느 매장인가"를 알 수 없었다. 그래서
 * 푸시 발송 같은 엔드포인트는 "로그인은 했다"까지만 확인하고, 매장 id 는
 * 요청 본문에서 받아 그대로 믿었다 — 로그인한 아무나 남의 매장으로 푸시를
 * 보낼 수 있었다는 뜻이다.
 *
 * Supabase 로 옮기면서 auth.uid() 가 곧 users.id 가 됐다. 이제 물어볼 수 있다.
 *
 * @returns 사장이면 자기 id, 승인된 직원이면 소속 매장 id. 그 외 null.
 */
export async function resolveCallerStore(
  authorizationHeader: string | undefined
): Promise<{ userId: string; storeId: string | null; role: string } | null> {
  const token = String(authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const sb = getSupabaseAdmin();
  const db = getDb();
  if (!sb || !db) return null;

  const { data, error } = await sb.auth.getUser(token);
  const userId = data?.user?.id;
  if (error || !userId) return null;

  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) return { userId, storeId: null, role: '' };
  const u = snap.data() as any;
  const role = String(u?.role ?? '');
  const storeId =
    role === 'owner'
      ? userId
      : role === 'staff' && u?.employerStatus === 'approved'
        ? (u?.employerStoreId ?? null)
        : null;
  return { userId, storeId, role };
}

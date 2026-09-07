import { timingSafeEqual } from 'node:crypto';

import { getDb, getSupabaseAdmin } from './db.js';

// 문서 ID 로 안전한 storeId 인지 — 빈값·슬래시·예약어(__x__)·과도한 길이 차단.
// (잘못된 id 를 쿼리에 넘기면 드라이버가 throw → 내부 에러 500 노출되므로 미리 400 으로 거른다.)
export function isValidStoreId(id: any): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/') && !/^__.*__$/.test(id);
}

/** 길이가 달라도 시간이 새지 않게 비교한다. 공유키·비밀번호 대조는 전부 이걸 쓴다. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// 공유키 인증 — 미설정 시 503(실수로 공개 방지). 음성채널 webhook 은 x-ai-key 헤더로 호출.
export function checkAiReservationAuth(req: any, res: any): boolean {
  const key = process.env.AI_RESERVATION_KEY;
  if (!key) { res.status(503).json({ error: 'AI_RESERVATION_NOT_CONFIGURED' }); return false; }
  if (!safeEqual(String(req.headers['x-ai-key'] ?? ''), key)) { res.status(401).json({ error: 'invalid key' }); return false; }
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

/**
 * "이 요청은 사장님(또는 승인 직원)이 자기 매장에 대해 보낸 것"을 확인하고 매장 id 를 준다.
 * 아니면 응답을 이미 보냈으니 호출자는 그냥 return 하면 된다.
 *
 * 본문의 storeId 는 **믿지 않는다.** 있으면 토큰의 매장과 같은지 확인만 한다 —
 * 다르면 클라이언트가 어긋난 상태이므로 조용히 바꿔치기보다 403 으로 알린다.
 */
export async function requireStore(
  req: any,
  res: any,
  opts: { ownerOnly?: boolean } = {}
): Promise<{ userId: string; storeId: string; role: string } | null> {
  const caller = await resolveCallerStore(req.headers.authorization);
  if (!caller) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!caller.storeId) { res.status(403).json({ error: 'store member only' }); return null; }
  if (opts.ownerOnly && caller.role !== 'owner') { res.status(403).json({ error: 'owner only' }); return null; }
  const bodyStore = req.body?.storeId;
  if (bodyStore && bodyStore !== caller.storeId) { res.status(403).json({ error: 'not your store' }); return null; }
  return { userId: caller.userId, storeId: caller.storeId, role: caller.role };
}

// ============================================================
// 마스터 — 공유 비밀번호 하나로 여는 관리자 경로.
//
// 값은 **클라이언트가 못 읽는 곳**에 둔다: app_secrets/master (정책 없는 서버 전용
// 테이블) 또는 환경변수 MASTER_PASSWORD. 예전에는 app_state 에 있어서 로그인한
// 누구나 읽었고, 그 값으로 재설정 API 를 불러 아무 계정이나 열 수 있었다.
//
// 어디에도 없으면 열리지 않는다(503). 기본값('IMC' 같은)을 두지 않는다 —
// 기본값은 곧 공개된 비밀번호다.
// ============================================================

const masterBuckets = new Map<string, { count: number; resetAt: number }>();
const checkMasterRate = (ip: string): boolean => {
  const now = Date.now();
  if (masterBuckets.size > 5000) masterBuckets.clear();
  const b = masterBuckets.get(ip);
  if (!b || now > b.resetAt) {
    masterBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 10) return false;
  b.count += 1;
  return true;
};

/** 저장된 마스터 비밀번호. 없으면 null. */
export async function getMasterPassword(): Promise<string | null> {
  const db = getDb();
  if (db) {
    try {
      const snap = await db.collection('app_secrets').doc('master').get();
      const stored = snap.data()?.password;
      if (typeof stored === 'string' && stored) return stored;
    } catch (e: any) {
      console.warn('[master] app_secrets 조회 실패', e?.message);
    }
  }
  return process.env.MASTER_PASSWORD || null;
}

/**
 * x-master-password 헤더를 대조한다. 통과하면 true, 아니면 응답을 보내고 false.
 * IP 당 분당 10회 — 공유 비밀번호를 무차별로 맞춰 보는 걸 막는다.
 */
export async function requireMaster(req: any, res: any): Promise<boolean> {
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  if (!checkMasterRate(ip)) {
    res.status(429).json({ error: '시도가 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    return false;
  }
  const given = req.headers['x-master-password'];
  if (typeof given !== 'string' || !given) {
    res.status(401).json({ error: 'master password required' });
    return false;
  }
  const stored = await getMasterPassword();
  if (!stored) {
    res.status(503).json({ error: 'master password not configured' });
    return false;
  }
  if (!safeEqual(given, stored)) {
    res.status(401).json({ error: 'bad master password' });
    return false;
  }
  return true;
}

import { Router } from 'express';

import { mintDeviceSession } from '../lib/authAdmin.js';
import { FieldValue, getDb, getSupabaseAdmin } from '../lib/db.js';

const router = Router();


// ============================================================
// PRINT BRIDGE — 영수증 인쇄 에이전트 페어링 API
// ============================================================
// 흐름:
//   1) POST /api/print-bridge/issue-code — 사장님이 결 웹앱에서 호출
//      → 6자리 랜덤 코드 생성, pairing_codes/{code} 에 5분 TTL 로 저장
//      → 클라이언트는 코드를 사장님에게 화면 표시
//   2) POST /api/print-bridge/exchange { code } — 에이전트(트레이 앱)가 호출
//      → 코드 유효성 검증 → Supabase 기기 세션 토큰 발급 → 코드 즉시 삭제
//      → 에이전트는 verifyOtp 로 세션을 만들고 print_jobs 를 구독
//
// 기기 계정은 **사람 계정이 아니다.** public.users 행을 만들지 않고, app_metadata 의
// storeId 로만 신원을 갖는다. 그래서 print_jobs 말고는 아무것도 볼 수 없다
// (supabase/migrations 20260901000400 의 my_device_store_id 참고).

// 단순 코드 발급 rate limit — 매장당 1분에 3회까지
const pairingBuckets = new Map<string, { count: number; resetAt: number }>();
const checkPairingRate = (storeId: string): boolean => {
  const now = Date.now();
  const b = pairingBuckets.get(storeId);
  if (!b || now > b.resetAt) {
    pairingBuckets.set(storeId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 3) return false;
  b.count += 1;
  return true;
};

router.post('/api/print-bridge/issue-code', async (req, res) => {
  try {
    const { storeId, ownerName } = req.body ?? {};
    if (!storeId || typeof storeId !== 'string') {
      return res.status(400).json({ error: 'storeId required' });
    }
    if (!checkPairingRate(storeId)) {
      return res.status(429).json({ error: '코드 발급이 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    }
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    // 6자리 코드 — 0 으로 시작 가능 (보안상 큰 문제 아님, 짧은 TTL 로 보완)
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const expiresAtMs = Date.now() + 5 * 60_000;

    await db.collection('pairing_codes').doc(code).set({
      storeId,
      ownerName: ownerName ?? null,
      expiresAt: expiresAtMs,
      createdAt: FieldValue.serverTimestamp(),
    });

    res.json({ code, expiresAt: new Date(expiresAtMs).toISOString() });
  } catch (e: any) {
    console.error('[print-bridge/issue-code]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? '페어링 코드 발급 실패' });
  }
});

router.post('/api/print-bridge/exchange', async (req, res) => {
  try {
    const { code, deviceName } = req.body ?? {};
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: '6자리 코드가 필요합니다.' });
    }
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const docRef = db.collection('pairing_codes').doc(code);
    const snap = await docRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: '코드가 만료되었거나 잘못된 코드입니다.' });
    }
    const data = snap.data() as unknown as { storeId: string; expiresAt: number };
    if (Date.now() > data.expiresAt) {
      await docRef.delete().catch(() => {});
      return res.status(410).json({ error: '코드 유효 시간(5분)이 지났어요. 새 코드를 발급받아 주세요.' });
    }

    // 기기 세션. 매장마다 계정 하나 — 프린터를 바꿔 달아도 같은 계정을 다시 쓴다.
    // storeId 는 app_metadata 에 들어가고, 그건 service_role 만 쓸 수 있어 위조되지 않는다.
    const { tokenHash } = await mintDeviceSession('printbridge', data.storeId, data.storeId);

    // 사장님 user 문서에 페어링 디바이스 정보 기록 (UX 용)
    try {
      await db.collection('users').doc(data.storeId).set({
        printBridgeDevice: {
          name: deviceName ?? null,
          pairedAt: new Date().toISOString(),
        },
      }, { merge: true });
    } catch (e: any) {
      console.warn('[print-bridge/exchange] device record skip', e?.message);
    }

    // 코드는 1회용 — 즉시 삭제
    await docRef.delete().catch(() => {});

    res.json({ tokenHash, storeId: data.storeId });
  } catch (e: any) {
    console.error('[print-bridge/exchange]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? '페어링 교환 실패' });
  }
});

/**
 * 기기 하트비트 + 매장 이름 조회.
 *
 * 기기는 users 테이블을 읽지도 쓰지도 못한다 — RLS 상 print_jobs 만 보인다.
 * 그래서 예전에 에이전트가 직접 하던 두 가지(하트비트 기록, 매장명 조회)를
 * 여기로 옮겼다. 서버가 대신 하되, **매장 id 는 요청 본문이 아니라 토큰에서 읽는다.**
 * 본문에서 읽으면 아무 기기나 남의 매장 이름을 가져갈 수 있다.
 */
router.post('/api/print-bridge/heartbeat', async (req, res) => {
  try {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer) return res.status(401).json({ error: 'token required' });

    const sb = getSupabaseAdmin();
    const db = getDb();
    if (!sb || !db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const { data, error } = await sb.auth.getUser(bearer);
    const meta = (data?.user?.app_metadata ?? {}) as { device?: string; storeId?: string };
    if (error || meta.device !== 'printbridge' || !meta.storeId) {
      return res.status(401).json({ error: 'not a paired device' });
    }

    const storeId = meta.storeId;
    await db.collection('users').doc(storeId).set({
      printBridgeHeartbeatAt: new Date().toISOString(),
    }, { merge: true });

    const snap = await db.collection('users').doc(storeId).get();
    res.json({ storeId, restaurantName: snap.data()?.restaurantName ?? null });
  } catch (e: any) {
    console.error('[print-bridge/heartbeat]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'heartbeat 실패' });
  }
});

export default router;

import { Router } from 'express';

import { getDb, getSupabaseAdmin } from '../lib/db.js';
import { getMasterPassword, resolveCallerStore, safeEqual } from '../lib/storeAuth.js';
import { isAcceptablePassword, normalizeLoginPhone, phoneLoginEmail } from '../../src/lib/phoneLoginEmail.js';

const router = Router();

// ============================================================
// 전화번호 + 비밀번호 가입 — **문자 발송 없이.**
//
// 왜 이게 필요한가. 전화번호 OTP 는 문자 발송 업체가 있어야 동작하는데, 그게 아직
// 없다. 그렇다고 예전처럼 "번호만 맞으면 로그인"으로 되돌릴 수는 없다 — 그건
// 남의 번호만 알면 그 사람 계정에 들어가던 그 구멍이다. 자격 증명은 있어야 한다.
//
// 그래서 번호를 **아이디**로, 비밀번호를 **자격 증명**으로 쓴다. 그릇은 Supabase 의
// 이메일 로그인이다(기본으로 켜져 있어 공급자가 필요 없다). 사용자는 그 주소를
// 볼 일이 없다 — 화면에는 전화번호만 나온다.
//
// **가입만 서버를 거친다.** 클라이언트에서 바로 signUp 하면 Supabase 가 이메일
// 확인을 요구하는데, 그 주소는 받을 사람이 없는 주소다. 서버가 service_role 로
// 확인된 상태로 만들어 준다. 로그인은 클라이언트에서 바로 한다.
//
// ⚠️ 한계: 지금은 **비밀번호를 잊으면 본인이 되찾을 수 없다.** 번호로 문자를 보낼
//    수단이 없기 때문이다. 사장님이 직원 계정을, 마스터 화면이 사장님 계정을
//    재설정해 주는 경로가 필요하다(아래 reset). 문자가 붙으면 OTP 재설정으로 바꾼다.
// ============================================================

/** 가입 시도 rate limit — IP 당 분당 5회. 번호를 훑어 계정을 만들어 두는 걸 막는다. */
const signupBuckets = new Map<string, { count: number; resetAt: number }>();
const checkSignupRate = (ip: string): boolean => {
  const now = Date.now();
  if (signupBuckets.size > 5000) signupBuckets.clear();
  const b = signupBuckets.get(ip);
  if (!b || now > b.resetAt) {
    signupBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 5) return false;
  b.count += 1;
  return true;
};

router.post('/api/auth/phone/signup', async (req, res) => {
  try {
    const ip = String(req.ip || 'unknown').split(',')[0].trim();
    if (!checkSignupRate(ip)) {
      return res.status(429).json({ error: '가입 시도가 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    }

    const sb = getSupabaseAdmin();
    if (!sb) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const { phone, password } = req.body ?? {};
    const email = phoneLoginEmail(String(phone ?? ''));
    if (!email) return res.status(400).json({ error: 'invalid-phone' });
    if (!isAcceptablePassword(String(password ?? ''))) {
      return res.status(400).json({ error: 'weak-password' });
    }

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password: String(password),
      // 받을 사람이 없는 주소다. 확인 절차를 태우면 아무도 가입을 못 끝낸다.
      email_confirm: true,
      user_metadata: { phone: normalizeLoginPhone(String(phone)), loginKind: 'phone-password' },
    });

    if (error) {
      const msg = `${(error as any)?.code ?? ''} ${error.message ?? ''}`.toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        // 이미 있는 번호. "이 번호는 가입돼 있다"는 사실 자체는 숨기지 않는다 —
        // 가입 화면에서 그걸 안 알려주면 사용자가 왜 안 되는지 알 수 없다.
        return res.status(409).json({ error: 'already-registered' });
      }
      throw error;
    }

    res.json({ ok: true, userId: data.user?.id });
  } catch (e: any) {
    console.error('[auth/phone/signup]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'signup failed' });
  }
});

// ============================================================
// 비밀번호 재설정 — 본인이 아니라 **관리자가** 해 준다.
//
// 문자를 보낼 수단이 없으니 "번호로 인증하고 스스로 바꾸기"는 불가능하다.
// 대신 이미 신뢰 관계가 있는 사람이 대신 바꿔 준다:
//   · 사장님 → 자기 매장 직원
//   · 마스터 → 누구든 (앱의 기존 마스터 비밀번호 모델을 그대로 쓴다)
//
// 사장님이 **손님** 비밀번호는 못 바꾼다. 바꿀 수 있으면 사장님이 손님 계정에
// 들어가 다른 매장 방문 기록까지 볼 수 있다 — 계정 탈취 경로다. 직원은 그 매장
// 소속이라 다르다.
//
// 마스터 경로는 공유 비밀번호 하나로 열린다. 약하다. 하지만 마스터 화면이 이미
// 같은 비밀번호로 계정을 **삭제**할 수 있으므로, 여기서 더 약해지는 건 없다.
// 마스터 인증 자체를 강화하는 건 별도 작업이다.
// ============================================================

const resetBuckets = new Map<string, { count: number; resetAt: number }>();
const checkResetRate = (ip: string): boolean => {
  const now = Date.now();
  if (resetBuckets.size > 5000) resetBuckets.clear();
  const b = resetBuckets.get(ip);
  if (!b || now > b.resetAt) {
    resetBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 10) return false;
  b.count += 1;
  return true;
};

router.post('/api/auth/phone/reset', async (req, res) => {
  try {
    const ip = String(req.ip || 'unknown').split(',')[0].trim();
    if (!checkResetRate(ip)) {
      return res.status(429).json({ error: '시도가 너무 잦아요. 1분 후 다시 시도해 주세요.' });
    }

    const sb = getSupabaseAdmin();
    const db = getDb();
    if (!sb || !db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });

    const { targetUserId, newPassword } = req.body ?? {};
    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ error: 'targetUserId required' });
    }
    if (!isAcceptablePassword(String(newPassword ?? ''))) {
      return res.status(400).json({ error: 'weak-password' });
    }

    // ── 누가 요청했나 ──
    let allowed = false;

    // 1) 마스터 — app_secrets(서버 전용) 또는 MASTER_PASSWORD 환경변수와 대조.
    //    예전엔 app_state 에 있어 로그인한 누구나 읽을 수 있었다.
    const masterHeader = req.headers['x-master-password'];
    if (typeof masterHeader === 'string' && masterHeader) {
      const stored = await getMasterPassword();
      if (stored && safeEqual(masterHeader, stored)) allowed = true;
      else return res.status(401).json({ error: 'bad master password' });
    }

    // 2) 사장님 — 자기 매장의 직원만.
    if (!allowed) {
      const caller = await resolveCallerStore(req.headers.authorization);
      if (!caller) return res.status(401).json({ error: 'unauthorized' });
      if (caller.role !== 'owner') return res.status(403).json({ error: 'owner only' });

      const target = (await db.collection('users').doc(targetUserId).get()).data();
      if (!target) return res.status(404).json({ error: 'user not found' });
      const isMyStaff = target.role === 'staff' && target.employerStoreId === caller.userId;
      if (!isMyStaff) return res.status(403).json({ error: 'not your staff' });
      allowed = true;
    }

    const { error } = await sb.auth.admin.updateUserById(targetUserId, {
      password: String(newPassword),
    });
    if (error) throw error;

    res.json({ ok: true });
  } catch (e: any) {
    console.error('[auth/phone/reset]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'reset failed' });
  }
});

// ============================================================
// 탈퇴 — auth 사용자를 지운다.
//
// users 행만 손보면(예전 방식: status='deleted') auth 사용자가 남는다. 그 번호로
// 다시 로그인하면 빈 프로필로 계정이 되살아나고, 같은 번호로 새로 가입은 안 된다
// ("이미 가입된 번호"). auth.users 를 지우면 users.id 외래키가 cascade 로 방문·쿠폰
// 등 관련 행을 함께 정리한다. 본인 토큰으로만.
// ============================================================
router.post('/api/auth/delete-account', async (req, res) => {
  try {
    const sb = getSupabaseAdmin();
    if (!sb) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const { data, error } = await sb.auth.getUser(token);
    const uid = data?.user?.id;
    if (error || !uid) return res.status(401).json({ error: 'invalid token' });
    const del = await sb.auth.admin.deleteUser(uid);
    if (del.error) throw del.error;
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[auth/delete-account]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'delete failed' });
  }
});

export default router;

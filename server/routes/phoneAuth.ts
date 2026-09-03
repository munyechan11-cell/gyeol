import { Router } from 'express';

import { getSupabaseAdmin } from '../lib/db.js';
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

export default router;

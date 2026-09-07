import { Router } from 'express';

import { getDb, getSupabaseAdmin } from '../lib/db.js';
import { requireMaster } from '../lib/storeAuth.js';
import { isAcceptablePassword } from '../../src/lib/phoneLoginEmail.js';

const router = Router();

// ============================================================
// 마스터 화면 — 전부 서버에서 한다.
//
// 예전 구조: 마스터 비밀번호가 app_state 에 있고, 클라이언트가 그걸 읽어 입력값과
// 비교했다. 그러면 (a) 로그인한 누구나 그 비밀번호를 읽고, (b) 마스터가 하는
// 일(전 계정 목록·삭제)이 로그인한 계정의 RLS 범위 안에서만 됐다 — RLS 를 좁힌
// 지금은 사장님 계정으로도 다른 사장님이 안 보인다.
//
// 이제 마스터 화면은 비밀번호를 **보내기만** 한다. 서버가 대조하고, 목록·삭제·
// 재설정은 service_role 로 처리한다. 클라이언트는 비밀번호를 메모리에만 들고 있다.
// ============================================================

/** 비밀번호가 맞는지만 확인한다. 화면은 이걸로 마스터 모드에 들어간다. */
router.post('/api/master/login', async (req, res) => {
  if (!(await requireMaster(req, res))) return;
  res.json({ ok: true });
});

/** 마스터 비밀번호 변경 — 현재 비밀번호로 인증한 뒤. */
router.post('/api/master/password', async (req, res) => {
  try {
    if (!(await requireMaster(req, res))) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const next = String(req.body?.newPassword ?? '');
    if (!isAcceptablePassword(next)) return res.status(400).json({ error: 'weak-password' });
    await db.collection('app_secrets').doc('master').set({ password: next });
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[master/password]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'failed' });
  }
});

/**
 * 전 계정 목록 — 마스터 화면의 사장님/직원/손님 탭.
 * 화면이 쓰는 필드만 준다. 토큰·키 같은 건 목록에 필요 없다.
 */
router.get('/api/master/users', async (req, res) => {
  try {
    if (!(await requireMaster(req, res))) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const snap = await db.collection('users').get();
    const users = snap.docs.map((d) => {
      const u = d.data();
      return {
        id: d.id,
        role: u.role,
        name: u.name ?? '',
        phone: u.phone ?? '',
        restaurantName: u.restaurantName,
        status: u.status,
        authType: u.authType,
        employerStoreId: u.employerStoreId,
        employerStatus: u.employerStatus,
        position: u.position,
        createdAt: u.createdAt,
      };
    });
    res.json({ users });
  } catch (e: any) {
    console.error('[master/users]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'failed' });
  }
});

/**
 * 계정 삭제 — auth 사용자를 지운다. users.id 의 외래키가 cascade 라 매장·손님 자료가
 * 함께 사라진다. (users 행만 지우면 auth 사용자가 남아 재로그인 시 빈 계정으로 되살아난다.)
 */
router.post('/api/master/delete-user', async (req, res) => {
  try {
    if (!(await requireMaster(req, res))) return;
    const sb = getSupabaseAdmin();
    if (!sb) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const userId = String(req.body?.userId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return res.status(400).json({ error: 'userId required' });
    const { error } = await sb.auth.admin.deleteUser(userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e: any) {
    console.error('[master/delete-user]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'failed' });
  }
});

export default router;

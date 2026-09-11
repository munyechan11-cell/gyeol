import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { aiReservationConfig, findFreeTable, hmToMin, isStoreOpenAt, loadStoreDay, minToHm, pickFreeTable, tryBookReservation } from '../lib/reservation.js';
import { checkAiReservationAuth, isValidStoreId } from '../lib/storeAuth.js';

const router = Router();


// ============================================================
// Retell 어댑터 — Retell custom function 형식({ args })을 받아 예약 로직에 연결.
// storeId 는 Retell "Query Parameters"(가게별 고정값)로 받아 LLM 이 못 건드린다.
// 사업 결과(closed/full/duplicate/too_large)는 200 + ok/available:false 로 돌려줘
// Retell LLM 이 에러가 아닌 정상 도구 응답으로 읽고 손님에게 안내하게 한다.
// ============================================================
function retellArgs(req: any): any {
  const b = req.body ?? {};
  return b && typeof b.args === 'object' && b.args ? b.args : b; // { args } 형식 우선, flat 도 허용
}

router.post('/api/retell/availability', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const storeId = String(req.query.storeId || '');
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId(query) required' });
    const a = retellArgs(req);
    const date = String(a.date || '');
    const time = String(a.time || '');
    const size = Math.max(1, Math.min(99, Number(a.partySize) || 1));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return res.json({ available: false, message: '날짜(YYYY-MM-DD)와 시간(HH:MM) 형식이 필요해요.' });
    }
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled' });
    if (!isStoreOpenAt(owner, date, time)) return res.json({ available: false, reason: 'closed' });
    const table = await findFreeTable(db, storeId, date, time, size, durationMin);
    if (table) return res.json({ available: true, tableNumber: table.number });
    const { tables, reservations } = await loadStoreDay(db, storeId, date);
    const alternatives: string[] = [];
    for (const delta of [30, -30, 60, -60, 90, -90, 120, -120]) {
      const alt = minToHm(hmToMin(time) + delta);
      if (isStoreOpenAt(owner, date, alt) && pickFreeTable(tables, reservations, alt, size, durationMin)) {
        alternatives.push(alt);
        if (alternatives.length >= 3) break;
      }
    }
    return res.json({ available: false, reason: 'full', alternatives });
  } catch (e: any) { console.error('[retell/availability]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

router.post('/api/retell/slots', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const storeId = String(req.query.storeId || '');
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId(query) required' });
    const a = retellArgs(req);
    const date = String(a.date || '');
    const size = Math.max(1, Math.min(99, Number(a.partySize) || 1));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ slots: [], message: '날짜(YYYY-MM-DD)가 필요해요.' });
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled' });
    const { tables, reservations } = await loadStoreDay(db, storeId, date);
    const slots: string[] = [];
    for (let m = 0; m < 1440 && slots.length < 20; m += 30) {
      const time = minToHm(m);
      if (isStoreOpenAt(owner, date, time) && pickFreeTable(tables, reservations, time, size, durationMin)) slots.push(time);
    }
    return res.json({ date, slots });
  } catch (e: any) { console.error('[retell/slots]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

router.post('/api/retell/book', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const storeId = String(req.query.storeId || '');
    if (!isValidStoreId(storeId)) return res.status(400).json({ error: 'storeId(query) required' });
    const a = retellArgs(req);
    const date = String(a.date || '');
    const time = String(a.time || '');
    const size = Math.max(1, Math.min(99, Number(a.partySize) || 1));
    const customerName = String(a.customerName || '').trim();
    const customerPhone = String(a.customerPhone || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !customerName || !customerPhone) {
      return res.json({ ok: false, error: 'missing', message: '날짜·시간·인원·성함·연락처가 모두 필요해요.' });
    }
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled' });
    const result = await tryBookReservation(db, owner, storeId, { date, time, partySize: size, customerName, customerPhone }, durationMin);
    if (result.status === 'ok') return res.json({ ok: true, date, time, partySize: size, tableNumber: result.reservation.tableNumber, customerName });
    if (result.status === 'duplicate') return res.json({ ok: false, error: 'duplicate', existing: result.existing });
    if (result.status === 'too_large') return res.json({ ok: false, error: 'too_large', maxSeats: result.maxSeats });
    if (result.status === 'closed') return res.json({ ok: false, error: 'closed' });
    return res.json({ ok: false, error: 'full' });
  } catch (e: any) { console.error('[retell/book]', e?.message); res.status(500).json({ error: e?.message ?? 'failed' }); }
});

export default router;

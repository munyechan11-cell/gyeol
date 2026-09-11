import { Router } from 'express';
import { getDb } from '../lib/db.js';
import { parseLooseJson } from '../lib/parsers.js';
import { aiReservationConfig, callLLMText, findFreeTable, hmToMin, isStoreOpenAt, loadStoreDay, minToHm, pickFreeTable, tryBookReservation } from '../lib/reservation.js';
import type { BookInput } from '../lib/reservation.js';
import { checkAiReservationAuth, isValidStoreId } from '../lib/storeAuth.js';

const router = Router();

// 예약 대화(/agent) rate limit — 매장당 분당 20회. LLM 호출/장애 증폭 방지(IP 아닌 storeId 기준 — 음성 webhook 은 IP 공유).
const agentBuckets = new Map<string, { count: number; resetAt: number }>();
const checkAgentRate = (storeId: string): boolean => {
  const now = Date.now();
  if (agentBuckets.size > 5000) agentBuckets.clear(); // 메모리 가드
  const b = agentBuckets.get(storeId);
  if (!b || now > b.resetAt) { agentBuckets.set(storeId, { count: 1, resetAt: now + 60_000 }); return true; }
  if (b.count >= 20) return false;
  b.count += 1;
  return true;
};


router.post('/api/reservation/availability', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, date, time, partySize } = req.body ?? {};
    if (!isValidStoreId(storeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
      return res.status(400).json({ error: 'storeId, date(YYYY-MM-DD), time(HH:MM) required' });
    }
    const size = Math.max(1, Math.min(99, Number(partySize) || 1));
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled', available: false });
    if (!isStoreOpenAt(owner, date, time)) {
      return res.json({ available: false, reason: 'closed', alternatives: [] });
    }
    const table = await findFreeTable(db, storeId, date, time, size, durationMin);
    if (table) return res.json({ available: true, tableNumber: table.number, seats: table.seats });
    // 만석 — 같은 날 ±30/60/90분 대안 시간 탐색(영업시간 내 + 빈자리 있는 슬롯)
    const alternatives: string[] = [];
    for (const delta of [30, -30, 60, -60, 90, -90, 120, -120]) {
      const alt = minToHm(hmToMin(time) + delta);
      if (isStoreOpenAt(owner, date, alt) && (await findFreeTable(db, storeId, date, alt, size, durationMin))) {
        alternatives.push(alt);
        if (alternatives.length >= 3) break;
      }
    }
    return res.json({ available: false, reason: 'full', alternatives });
  } catch (e: any) {
    console.error('[reservation/availability]', e?.message);
    res.status(500).json({ error: e?.message ?? 'availability check failed' });
  }
});

router.post('/api/reservation/create', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, date, time, partySize, customerName, customerPhone, memo } = req.body ?? {};
    if (!isValidStoreId(storeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '') || !customerName || !customerPhone) {
      return res.status(400).json({ error: 'storeId, date, time, customerName, customerPhone required' });
    }
    const size = Math.max(1, Math.min(99, Number(partySize) || 1));
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled', available: false });

    const result = await tryBookReservation(db, owner, storeId, { date, time, partySize: size, customerName, customerPhone, memo }, durationMin);
    if (result.status === 'closed') return res.status(409).json({ error: 'closed', available: false });
    if (result.status === 'duplicate') {
      return res.status(409).json({ error: 'duplicate', message: '같은 번호로 비슷한 시간대 예약이 이미 있어요.', existing: result.existing });
    }
    if (result.status === 'too_large') return res.status(409).json({ error: 'too_large', maxSeats: result.maxSeats, available: false });
    if (result.status === 'full') return res.status(409).json({ error: 'full', available: false });
    return res.json({ ok: true, reservation: result.reservation });
  } catch (e: any) {
    console.error('[reservation/create]', e?.message);
    res.status(500).json({ error: e?.message ?? 'reservation create failed' });
  }
});

// 전화번호 → storeId 매핑 — 음성채널이 통화 시작 시 호출해 "어느 매장 예약인지" 식별.
// 가게마다 전화번호가 다르므로(storeConfig.aiReservation.phoneNumber) 이 번호로 매장을 찾는다.
router.post('/api/reservation/resolve-store', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const norm = String(req.body?.phoneNumber || '').replace(/[^\d+]/g, '');
    if (!norm) return res.status(400).json({ error: 'phoneNumber required' });
    const snap = await db
      .collection('users')
      .where('storeConfig.aiReservation.phoneNumber', '==', norm)
      .limit(5)
      .get();
    const store = snap.docs
      .map((d: any) => ({ id: d.id, ...d.data() }))
      .find((u: any) => u.role === 'owner' && u.storeConfig?.aiReservation?.enabled === true);
    if (!store) return res.status(404).json({ matched: false, error: 'store not found or AI disabled' });
    return res.json({
      matched: true,
      storeId: store.id,
      restaurantName: store.restaurantName ?? '',
      greeting: store.storeConfig?.aiReservation?.greeting || '',
    });
  } catch (e: any) {
    console.error('[reservation/resolve-store]', e?.message);
    res.status(500).json({ error: e?.message ?? 'resolve failed' });
  }
});

// 예약 가능 시간대 목록 — AI 가 "○시, ○시 가능해요" 라고 손님에게 대안을 제시할 때 사용.
router.post('/api/reservation/slots', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, date, partySize, intervalMin } = req.body ?? {};
    if (!isValidStoreId(storeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return res.status(400).json({ error: 'storeId, date(YYYY-MM-DD) required' });
    }
    const size = Math.max(1, Math.min(99, Number(partySize) || 1));
    const step = Math.max(15, Math.min(120, Number(intervalMin) || 30));
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled' });
    // 테이블·당일 예약을 1회만 조회 후, step 간격으로 영업시간을 훑어 빈자리 있는 시간만 수집(최대 20개).
    const { tables, reservations } = await loadStoreDay(db, storeId, date);
    const slots: string[] = [];
    for (let m = 0; m < 1440 && slots.length < 20; m += step) {
      const time = minToHm(m);
      if (!isStoreOpenAt(owner, date, time)) continue;
      if (pickFreeTable(tables, reservations, time, size, durationMin)) slots.push(time);
    }
    return res.json({ date, partySize: size, slots });
  } catch (e: any) {
    console.error('[reservation/slots]', e?.message);
    res.status(500).json({ error: e?.message ?? 'slots failed' });
  }
});

// ============================================================
// 예약 대화 두뇌 (TODO 6-4) — 벤더 중립. 음성채널(또는 텍스트)이 대화 누적(messages)을 보내면
// LLM 이 발화를 이해해 예약 정보를 모으고 다음 질문을 만든다. 단, 실제 예약 확정은 항상 서버
// (tryBookReservation)가 결정론적으로 수행 — LLM 이 "예약됐다"를 임의로 말하지 못하게 한다.
// 어떤 음성 플랫폼(Vapi/Retell/Twilio+Realtime)을 골라도 이 엔드포인트를 그대로 붙일 수 있다.
// ============================================================
router.post('/api/reservation/agent', async (req, res) => {
  try {
    if (!checkAiReservationAuth(req, res)) return;
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
    const { storeId, messages, today } = req.body ?? {};
    if (!isValidStoreId(storeId) || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'storeId, messages[] required' });
    }
    const ownerSnap = await db.collection('users').doc(storeId).get();
    if (!ownerSnap.exists) return res.status(404).json({ error: 'store not found' });
    const owner = ownerSnap.data();
    const { enabled, durationMin } = aiReservationConfig(owner);
    if (!enabled) return res.status(403).json({ error: 'ai_disabled' });

    const storeName = owner?.restaurantName || '저희 매장';
    const greeting = owner?.storeConfig?.aiReservation?.greeting || `안녕하세요, ${storeName}입니다. 예약 도와드릴까요?`;

    // 정규화된 대화 — role: 'user'(손님) | 'assistant'(AI)
    const convo = messages
      .filter((m: any) => m && typeof m.content === 'string')
      .map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 500) }));
    const userTurns = convo.filter((m: any) => m.role === 'user');
    // 첫 턴(손님 발화 없음) → 인사말만 (LLM 호출 없음 — rate limit 전에 처리)
    if (userTurns.length === 0) return res.json({ reply: greeting, intent: {}, done: false });

    // rate limit (LLM 호출 비용·장애 증폭 방지)
    if (!checkAgentRate(storeId)) {
      return res.status(429).json({ error: 'rate_limited', reply: '잠시만요, 곧 다시 도와드릴게요.' });
    }
    // 대화 턴 상한 — 정보 수렴 실패(LLM 오작동·형식 거부) 시 무한 되묻기 대신 사람 연결로 종료
    if (userTurns.length > 12) {
      return res.json({ reply: '예약 정보를 정확히 확인하기 어려워요. 잠시 후 직원이 직접 도와드릴게요. 감사합니다.', intent: {}, done: true, reason: 'handoff' });
    }

    const todayKst = (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today))
      ? today
      : new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 오늘

    const sys = `당신은 한국 식당 "${storeName}"의 친절한 전화 예약 접수원입니다. 손님과의 대화에서 예약 정보를 수집하세요.
오늘 날짜: ${todayKst}. 손님이 "내일", "이번주 토요일", "저녁 7시" 처럼 말하면 구체적 날짜(YYYY-MM-DD)와 24시간 시간(HH:MM)으로 변환하세요.
수집 항목: date(YYYY-MM-DD), time(HH:MM, 24시간), partySize(인원 수 정수), customerName(예약자 성함), customerPhone(연락처 숫자).
반드시 아래 JSON 객체 하나만 출력하세요. 그 외 설명·마크다운·코드펜스 금지:
{"date":"","time":"","partySize":0,"customerName":"","customerPhone":"","reply":"손님에게 할 다음 말","allCollected":false}
규칙:
- 아직 모르는 항목은 빈 문자열 또는 0 으로 두세요.
- reply 는 한국어 존댓말 1~2문장. 부족한 항목을 한 번에 하나씩 자연스럽게 물어보세요.
- 모든 항목을 다 알게 되면 allCollected=true 로 하고, reply 는 "잠시만요, 자리 확인해 드릴게요" 같은 짧은 말로 하세요. 예약 확정/완료는 시스템이 판단하므로 절대 "예약됐어요/완료됐어요" 라고 단정하지 마세요.
- 전화번호는 손님이 말한 숫자를 그대로 적으세요(하이픈 유무 무관).`;

    const userMsg = convo.map((m: any) => `${m.role === 'user' ? '손님' : '상담원'}: ${m.content}`).join('\n');

    let text: string | null;
    try {
      text = await callLLMText(sys, userMsg, 500);
    } catch (e: any) {
      console.error('[reservation/agent] llm', e?.message);
      return res.status(502).json({ error: 'AI_CALL_FAILED', reply: '죄송해요, 잠시 통화가 어려워요. 잠시 후 다시 시도해 주세요.' });
    }
    if (text === null) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' }); // 키 미설정
    if (!text.trim()) {
      // 호출은 됐으나 빈 응답 — 손님이 방금 말한 정보를 무시한 듯한 '더 알려주세요' 대신 재시도 유도
      return res.status(502).json({ error: 'AI_EMPTY_RESPONSE', reply: '죄송해요, 잘 못 들었어요. 다시 한 번 말씀해 주시겠어요?' });
    }

    const ext = parseLooseJson(text) || {};
    const intent = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(ext.date || '') ? ext.date : undefined,
      time: /^\d{2}:\d{2}$/.test(ext.time || '') ? ext.time : undefined,
      partySize: Number(ext.partySize) > 0 ? Math.min(99, Math.floor(Number(ext.partySize))) : undefined,
      customerName: ext.customerName ? String(ext.customerName).slice(0, 40) : undefined,
      customerPhone: ext.customerPhone ? String(ext.customerPhone).replace(/[^\d+]/g, '').slice(0, 20) : undefined,
    };
    const haveAll = intent.date && intent.time && intent.partySize && intent.customerName && intent.customerPhone;
    const askReply = (typeof ext.reply === 'string' && ext.reply.trim()) ? ext.reply.trim() : '예약 정보를 조금만 더 알려주세요.';

    // 정보가 아직 부족 → 다음 질문(LLM 문구) 반환
    if (!haveAll) {
      return res.json({ reply: askReply, intent, done: false });
    }

    // 모든 정보 수집됨 → 서버가 결정론적으로 예약 시도
    const result = await tryBookReservation(db, owner, storeId, intent as BookInput, durationMin);
    if (result.status === 'ok') {
      const r = result.reservation;
      return res.json({
        reply: `예약이 확정됐어요! ${r.date} ${r.time}, ${r.partySize}명, ${r.customerName}님 — ${r.tableNumber}번 테이블로 모실게요. 감사합니다 😊`,
        intent, booked: true, reservation: r, done: true,
      });
    }
    if (result.status === 'duplicate') {
      // 같은 시간대 중복 — 변경/추가는 서버가 처리 못 하므로(엔드포인트 없음) 거짓 약속 대신 매장 안내로 종료.
      const e = result.existing;
      return res.json({
        reply: `같은 번호로 ${e.date} ${e.time} 예약이 이미 있어요. 변경이나 추가 예약은 매장으로 직접 전화 주시면 도와드릴게요. 감사합니다.`,
        intent, done: true, reason: 'duplicate', existing: e,
      });
    }
    if (result.status === 'too_large') {
      // 인원이 최대 테이블 수용을 넘음 — 어떤 시간/날짜로도 불가하니 무의미한 대안 대신 명확히 안내하고 종료.
      return res.json({
        reply: `죄송해요, ${intent.partySize}명을 한 테이블로는 모시기 어려워요(최대 ${result.maxSeats}명). 단체석은 매장으로 직접 문의 부탁드려요.`,
        intent, done: true, reason: 'too_large', maxSeats: result.maxSeats,
      });
    }
    if (result.status === 'closed') {
      return res.json({ reply: `${intent.date} ${intent.time}은 영업시간이 아니에요. 다른 시간은 어떠세요?`, intent, done: false, reason: 'closed' });
    }
    // 만석 → 같은 날 대안 시간 제시 (하루 데이터 1회만 로드 후 메모리상 검사 — N+1 읽기 제거)
    const alts: string[] = [];
    const { tables: dayTables, reservations: dayRes } = await loadStoreDay(db, storeId, intent.date!);
    for (const delta of [30, -30, 60, -60, 90, -90, 120, -120]) {
      const alt = minToHm(hmToMin(intent.time!) + delta);
      if (isStoreOpenAt(owner, intent.date!, alt) && pickFreeTable(dayTables, dayRes, alt, intent.partySize!, durationMin)) {
        alts.push(alt);
        if (alts.length >= 3) break;
      }
    }
    const reply = alts.length
      ? `${intent.time}은 자리가 다 찼어요. ${alts.join(', ')} 중에는 가능한데, 어느 시간이 좋으세요?`
      : `${intent.date}은 예약이 가득 찼어요. 다른 날짜는 어떠세요?`;
    return res.json({ reply, intent, done: false, reason: 'full', alternatives: alts });
  } catch (e: any) {
    console.error('[reservation/agent]', e?.message);
    res.status(500).json({ error: e?.message ?? 'agent failed' });
  }
});

export default router;

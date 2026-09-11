import { getSupabaseAdmin } from '../lib/db.js';
import { fetchWithTimeout } from '../lib/http.js';
import { sendPushToOwner } from '../lib/push.js';


// ============================================================
// AI 예약 두뇌 (TODO 6-1) — 전화 AI·외부 음성채널이 호출하는 서버 엔드포인트.
//   /availability : 영업시간·테이블·기존예약으로 빈자리 판단(읽기)
//   /create       : 검증 통과 시 예약 생성 + 테이블 reserved + 사장님 푸시(쓰기)
// 전화 연동 전에 두뇌만 독립 테스트 가능. 서버-서버 호출이므로 공유키(AI_RESERVATION_KEY)로 보호.
// ============================================================
export const RES_DURATION_MIN = 90; // 한 예약이 테이블을 점유하는 기본 시간(분)

export function hmToMin(hm: string): number {
  const [h, m] = String(hm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function minToHm(total: number): string {
  const t = ((total % 1440) + 1440) % 1440; // 0~1439 로 래핑
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
// 영업시간 판단 — 클라이언트 businessHours.ts(단일 진실원) 규칙과 동일하게.
// 자정 넘는 영업(예: 18:00~02:00)·자정 넘는 휴게시간·마감 정각 배제(half-open [open,close))·open24h 우선 처리.
export function isStoreOpenAt(owner: any, date: string, time: string): boolean {
  if (owner?.temporarilyClosed) return false;
  const bh = owner?.businessHours;
  if (!bh) return true; // 미설정 = 항상 영업으로 간주
  if (bh.open24h) return true; // 24시간 영업은 closedDates 보다 우선 (client businessHours.ts:67 과 동일)
  if (Array.isArray(bh.closedDates) && bh.closedDates.includes(date)) return false;
  const day = new Date(`${date}T00:00:00`).getDay(); // 0=일
  const wk = bh.weekly?.[day];
  if (!wk || wk.closed) return false;
  const t = hmToMin(time);
  const openM = hmToMin(wk.open ?? '00:00');
  const closeM = hmToMin(wk.close ?? '23:59');
  // 마감 분은 닫힘으로(half-open). 자정 넘김(closeM<=openM)이면 [open,24:00)+[00:00,close).
  const inWindow = closeM <= openM ? t >= openM || t < closeM : t >= openM && t < closeM;
  if (!inWindow) return false;
  if (wk.breakStart && wk.breakEnd) {
    const bs = hmToMin(wk.breakStart);
    const be = hmToMin(wk.breakEnd);
    const inBreak = be <= bs ? t >= bs || t < be : t >= bs && t < be; // 자정 넘는 휴게도 처리
    if (inBreak) return false;
  }
  return true;
}
// 메모리상 빈 테이블 선택 — 요청 시간 ±durationMin 으로 점유 중이지 않은, 인원 충족 최소 테이블.
export function pickFreeTable(tables: any[], reservations: any[], time: string, partySize: number, durationMin: number) {
  const reqMin = hmToMin(time);
  const taken = new Set<number>(
    reservations
      .filter((r: any) => r.status === 'confirmed' && Math.abs(hmToMin(r.time) - reqMin) < durationMin)
      .map((r: any) => r.tableNumber)
  );
  return tables
    .filter((tb: any) => tb.type == null || tb.type === 'table' || tb.type === 'room')
    .filter((tb: any) => (tb.seats ?? 0) >= partySize && !taken.has(tb.number))
    .sort((a: any, b: any) => (a.seats ?? 0) - (b.seats ?? 0))[0] ?? null; // 가장 작은 적합 테이블 우선
}
// 한 매장·하루의 테이블·예약을 1회만 조회 (slots 처럼 여러 시간대 반복 검사 시 읽기 비용 절감)
export async function loadStoreDay(fs: any, storeId: string, date: string) {
  const [tablesSnap, resSnap] = await Promise.all([
    fs.collection('tables').where('storeId', '==', storeId).get(),
    fs.collection('reservations').where('storeId', '==', storeId).where('date', '==', date).get(),
  ]);
  return {
    tables: tablesSnap.docs.map((d: any) => d.data()),
    reservations: resSnap.docs.map((d: any) => d.data()),
  };
}
export async function findFreeTable(
  fs: any,
  storeId: string,
  date: string,
  time: string,
  partySize: number,
  durationMin: number = RES_DURATION_MIN
) {
  const { tables, reservations } = await loadStoreDay(fs, storeId, date);
  return pickFreeTable(tables, reservations, time, partySize, durationMin);
}
/** 매장의 AI 예약 설정 — 활성화 여부 + 점유시간(분). 비활성 매장은 예약 두뇌가 거부. */
export function aiReservationConfig(owner: any): { enabled: boolean; durationMin: number } {
  const c = owner?.storeConfig?.aiReservation ?? {};
  return {
    enabled: c.enabled === true,
    durationMin: Math.max(15, Math.min(360, Number(c.durationMin) || RES_DURATION_MIN)),
  };
}

// 다중 제공자 LLM 텍스트 생성 — Gemini→Anthropic→OpenAI 폴백(insight/floor-plan 과 동일 패턴).
// 설정된 키가 하나도 없으면 null 반환(호출부가 503 처리). 대화 이해·문구 생성 전용(예약 확정은 서버가 결정).
export async function callLLMText(systemPrompt: string, userMsg: string, maxTokens = 600): Promise<string | null> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !anthropicKey && !openaiKey) return null; // 키 0개 = 미설정 → 호출부 503
  // 각 제공자를 try/catch 로 감싸 런타임 장애 시 다음 제공자로 폴백. 전부 실패하면 마지막 에러를 throw(호출부 502).
  let lastErr: any;
  if (geminiKey) {
    try {
      const r = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey }, body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMsg }] }],
          // thinking 끔 — 2.5-flash 는 기본 thinking 이 출력 토큰을 먹어 본문이 잘리고 느려짐. 텍스트 생성엔 불필요.
          generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
        }) }, 20000);
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const d: any = await r.json();
      return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    } catch (e: any) { lastErr = e; console.warn('[callLLMText] gemini fail', e?.message); }
  }
  if (anthropicKey) {
    try {
      const r = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
      }, 20000);
      if (!r.ok) throw new Error(`Anthropic ${r.status}`);
      const d: any = await r.json();
      return d?.content?.[0]?.text?.trim() ?? '';
    } catch (e: any) { lastErr = e; console.warn('[callLLMText] anthropic fail', e?.message); }
  }
  if (openaiKey) {
    try {
      const r = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, max_tokens: maxTokens, messages: [
          { role: 'system', content: systemPrompt }, { role: 'user', content: userMsg },
        ] }),
      }, 20000);
      if (!r.ok) throw new Error(`OpenAI ${r.status}`);
      const d: any = await r.json();
      return d?.choices?.[0]?.message?.content?.trim() ?? '';
    } catch (e: any) { lastErr = e; console.warn('[callLLMText] openai fail', e?.message); }
  }
  throw lastErr ?? new Error('All LLM providers failed');
}

export interface BookInput { date: string; time: string; partySize: number; customerName: string; customerPhone: string; memo?: string; }
export type BookResult =
  | { status: 'closed' }
  | { status: 'duplicate'; existing: { date: string; time: string; partySize: number; tableNumber: number } }
  | { status: 'too_large'; maxSeats: number }
  | { status: 'full' }
  | { status: 'ok'; reservation: any };
// 결정론적 예약 처리 — 영업시간·중복·빈자리를 서버가 판단하고 생성한다.
// LLM 이 "예약됐다"를 임의로 말하지 못하게, 실제 booking 은 항상 이 함수가 단일 진실로 수행.
//
// **더블북을 막는 방식이 Firestore 때와 다르다.** 예전에는 읽기·판정·쓰기를 한
// 트랜잭션(runTransaction)으로 묶었다. 어댑터에는 트랜잭션이 없고, 그렇다고 그냥
// "읽고 → 판정하고 → 넣는다"로 옮기면 두 통화가 같은 빈 테이블을 보고 둘 다 예약을
// 넣는다. 손님 두 팀이 같은 자리에 앉고 나서야 알게 되는 종류의 버그다.
//
// 그래서 마지막 한 걸음만 DB 안으로 넣었다. book_reservation() 이 매장·날짜 단위
// 잠금을 잡고 "이 테이블 이 시간대가 아직 비었는지" 다시 확인한 뒤에만 삽입한다.
// 밖에서 고른 자리를 누가 먼저 채갔으면 false 가 돌아오고, 여기서 다시 고른다.
// 판정 규칙(영업시간·자리 고르기)은 TypeScript 에 그대로 남는다 — SQL 로 옮기면
// 규칙이 두 벌이 되고 언젠가 갈라진다.
export async function tryBookReservation(fs: any, owner: any, storeId: string, input: BookInput, durationMin: number): Promise<BookResult> {
  if (!isStoreOpenAt(owner, input.date, input.time)) return { status: 'closed' };
  const normPhone = String(input.customerPhone).replace(/[^\d+]/g, '').slice(0, 20);
  const reqMin = hmToMin(input.time);
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error('DB_NOT_CONFIGURED');

  // 이미 채인 자리를 빼 가며 다시 고른다. 동시 통화 수만큼만 돌면 되므로 몇 번이면 충분하다.
  const claimedByOthers = new Set<number>();

  for (let attempt = 0; attempt < 5; attempt++) {
    const { tables, reservations } = await loadStoreDay(fs, storeId, input.date);

    // 중복: 같은 번호 + 시간 겹침(±durationMin)만. 같은 날 다른 시간대(점심/저녁)는 허용.
    const dup = reservations.find((r: any) => r.status === 'confirmed'
      && String(r.customerPhone || '').replace(/[^\d+]/g, '') === normPhone
      && Math.abs(hmToMin(r.time) - reqMin) < durationMin);
    if (dup) return { status: 'duplicate', existing: { date: dup.date, time: dup.time, partySize: dup.partySize, tableNumber: dup.tableNumber } };

    // 인원이 매장 최대 수용을 넘으면 '만석'과 구분(어떤 시간/날짜로도 불가).
    const maxSeats = tables
      .filter((tb: any) => tb.type == null || tb.type === 'table' || tb.type === 'room')
      .reduce((mx: number, tb: any) => Math.max(mx, tb.seats ?? 0), 0);
    if (input.partySize > maxSeats) return { status: 'too_large', maxSeats };

    const usable = tables.filter((tb: any) => !claimedByOthers.has(tb.number));
    const table = pickFreeTable(usable, reservations, input.time, input.partySize, durationMin);
    if (!table) return { status: 'full' };

    const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reservation = {
      id, storeId, date: input.date, time: input.time,
      tableNumber: table.number,
      partySize: input.partySize,
      customerName: String(input.customerName).slice(0, 40),
      customerPhone: normPhone,
      memo: input.memo ? String(input.memo).slice(0, 200) : 'AI 전화 예약',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
    };

    const { data: booked, error } = await sb.rpc('book_reservation', {
      p_id: id,
      p_store: storeId,
      p_date: input.date,
      p_time: input.time,
      p_table_number: table.number,
      p_duration_min: durationMin,
      p_data: reservation,
    });
    if (error) throw error;

    if (!booked) {
      // 고르는 사이에 누가 채갔다. 그 자리를 빼고 다시 고른다.
      claimedByOthers.add(table.number);
      continue;
    }

    // 테이블 reserved 전이 — 화면 표시용이라 예약 확정과 원자적일 필요는 없다.
    // (실패해도 예약은 살아 있다. 반대로 묶어 두면 표시 갱신 실패가 예약을 되돌린다.)
    const cur = (table as any).status;
    if (!cur || cur === 'available' || cur === 'setup' || cur === 'reserved') {
      try {
        await fs.collection('tables').doc(`${storeId}_${table.number}`).set({ status: 'reserved' }, { merge: true });
      } catch (e: any) {
        console.warn('[tryBookReservation] 테이블 표시 갱신 실패', e?.message);
      }
    }

    return await withOwnerPush(storeId, input, { status: 'ok', reservation });
  }

  // 다섯 번 연속으로 채였다 — 그 시간대는 사실상 만석이다.
  return { status: 'full' };
}

/** 예약 성공 알림. 부수효과라 실패해도 예약 결과를 바꾸지 않는다. */
async function withOwnerPush(storeId: string, input: BookInput, result: BookResult): Promise<BookResult> {
  if (result.status === 'ok') {
    try {
      await sendPushToOwner({
        storeId, kind: 'ai-reservation', title: 'AI 전화 예약 접수',
        body: `${input.date} ${input.time} · ${input.partySize}명 · ${result.reservation.customerName} (${result.reservation.tableNumber}번 테이블)`,
        focusUrl: '/biz/owner/reservations', tag: `ai-res-${result.reservation.id}`,
      });
    } catch (e: any) {
      console.warn('[tryBookReservation] push fail', e?.message);
    }
  }
  return result;
}

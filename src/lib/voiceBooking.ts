import type { Reservation, TableDoc } from "./types";
import type { VoiceDraft, VoiceField } from "./voiceReservation";

/**
 * 음성 초안으로 예약 모달을 채울 때 쓰는 순수 로직.
 * 화면(Reservations.tsx)에서 떼어 둔 이유: 테이블 추천과 "다시 확인할 칸" 계산은 틀리면
 * 사장님이 모르고 저장하는 값이라 테스트로 고정한다.
 */

const NON_SEATING: ReadonlySet<string> = new Set(["corridor", "pos", "door"]);

/**
 * 같은 날짜·시간에 확정 예약이 없는 테이블 번호를 고른다.
 * 모달의 저장 검사(같은 날짜·시간·테이블의 확정 예약 중복 차단)와 같은 기준이다.
 *
 * 우선순위: 인원 수용 가능 + 비어 있음 → 비어 있음(수용 부족) → 1.
 * 어느 쪽도 "확정"이 아니다 — 사장님이 모달에서 바꿀 수 있는 제안일 뿐이다.
 */
export function suggestTable(
  tables: TableDoc[],
  reservations: Reservation[],
  storeId: string,
  date: string,
  time: string,
  partySize: number
): number {
  const taken = new Set(
    reservations
      .filter((r) => r.storeId === storeId && r.date === date && r.time === time && r.status === "confirmed")
      .map((r) => r.tableNumber)
  );
  const seating = tables
    .filter((t) => t.storeId === storeId && !NON_SEATING.has(t.type ?? "table"))
    .sort((a, b) => a.number - b.number);
  const free = seating.filter((t) => !taken.has(t.number));
  const fit = free.find((t) => t.seats >= partySize);
  if (fit) return fit.number;
  if (free.length > 0) return free[0].number;
  return 1;
}

/** 사장님이 다시 봐야 하는 칸 = 모델이 불확실하다고 한 칸 ∪ 아예 못 들은 칸. 순서는 화면 순서. */
export function fieldsToCheck(v: VoiceDraft): VoiceField[] {
  const order: VoiceField[] = ["customerName", "customerPhone", "date", "time", "partySize"];
  const missing = new Set<VoiceField>();
  if (!v.customerName) missing.add("customerName");
  if (!v.customerPhone) missing.add("customerPhone");
  if (!v.date) missing.add("date");
  if (!v.time) missing.add("time");
  if (v.partySize === undefined) missing.add("partySize");
  const flagged = new Set<VoiceField>([...v.uncertain, ...missing]);
  return order.filter((f) => flagged.has(f));
}

import { describe, expect, it } from "vitest";

import type { Reservation, TableDoc } from "./types";
import { fieldsToCheck, suggestTable } from "./voiceBooking";

const table = (number: number, seats: number, over: Partial<TableDoc> = {}): TableDoc =>
  ({ id: `t${number}`, number, storeId: "S", seats, x: 0, y: 0, ...over }) as TableDoc;

const res = (tableNumber: number, over: Partial<Reservation> = {}): Reservation =>
  ({
    id: `r${tableNumber}`, storeId: "S", date: "2026-10-03", time: "19:00", tableNumber, partySize: 2,
    customerName: "x", customerPhone: "010", status: "confirmed", ...over,
  }) as Reservation;

describe("suggestTable", () => {
  const tables = [table(1, 2), table(2, 4), table(3, 6)];

  it("인원을 수용하는 가장 앞 번호의 빈 테이블", () => {
    expect(suggestTable(tables, [], "S", "2026-10-03", "19:00", 2)).toBe(1);
    expect(suggestTable(tables, [], "S", "2026-10-03", "19:00", 4)).toBe(2);
    expect(suggestTable(tables, [], "S", "2026-10-03", "19:00", 5)).toBe(3);
  });

  it("같은 날짜·시간에 확정 예약이 있는 테이블은 건너뛴다", () => {
    expect(suggestTable(tables, [res(1)], "S", "2026-10-03", "19:00", 2)).toBe(2);
  });

  it("다른 시간·다른 날짜·취소된 예약은 막지 않는다", () => {
    expect(suggestTable(tables, [res(1, { time: "20:00" })], "S", "2026-10-03", "19:00", 2)).toBe(1);
    expect(suggestTable(tables, [res(1, { date: "2026-10-04" })], "S", "2026-10-03", "19:00", 2)).toBe(1);
    expect(suggestTable(tables, [res(1, { status: "cancelled" })], "S", "2026-10-03", "19:00", 2)).toBe(1);
  });

  it("남의 매장 예약·테이블은 보지 않는다", () => {
    expect(suggestTable([...tables, table(9, 8, { storeId: "OTHER" })], [res(1, { storeId: "OTHER" })], "S", "2026-10-03", "19:00", 2)).toBe(1);
  });

  it("수용 가능한 빈 테이블이 없으면 비어 있는 첫 테이블 (사장님이 모달에서 바꿈)", () => {
    expect(suggestTable(tables, [res(3)], "S", "2026-10-03", "19:00", 6)).toBe(1);
  });

  it("전부 찼거나 테이블이 없으면 1", () => {
    expect(suggestTable(tables, [res(1), res(2), res(3)], "S", "2026-10-03", "19:00", 2)).toBe(1);
    expect(suggestTable([], [], "S", "2026-10-03", "19:00", 2)).toBe(1);
  });

  it("복도·POS·문은 좌석이 아니다", () => {
    const t = [table(1, 4, { type: "corridor" }), table(2, 4, { type: "pos" }), table(3, 4, { type: "door" }), table(4, 4)];
    expect(suggestTable(t, [], "S", "2026-10-03", "19:00", 2)).toBe(4);
  });
});

describe("fieldsToCheck", () => {
  const full = { date: "2026-10-03", time: "19:00", partySize: 4, customerName: "김", customerPhone: "01012345678", transcript: "", uncertain: [] as const };

  it("전부 들었고 확실하면 비어 있다", () => {
    expect(fieldsToCheck({ ...full, uncertain: [] })).toEqual([]);
  });

  it("못 들은 칸과 불확실한 칸을 합쳐 화면 순서로 돌려준다", () => {
    const v = { ...full, customerPhone: undefined, time: "19:00", uncertain: ["time"] as ("time")[] };
    expect(fieldsToCheck(v)).toEqual(["customerPhone", "time"]);
  });

  it("인원 0 은 못 들은 게 아니라 값이 있는 것으로 보지 않는다 — 서버가 1~99 만 통과시키므로 undefined 만 누락", () => {
    expect(fieldsToCheck({ ...full, partySize: undefined, uncertain: [] })).toEqual(["partySize"]);
  });

  it("아무것도 못 들었으면 다섯 칸 전부", () => {
    expect(fieldsToCheck({ transcript: "", uncertain: [] })).toEqual(["customerName", "customerPhone", "date", "time", "partySize"]);
  });
});

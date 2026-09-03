import { describe, it, expect } from "vitest";
import { getStoreOpenStatus, defaultBusinessHours } from "./businessHours";
import type { BusinessHours, User } from "./types";

type Owner = Pick<User, "temporarilyClosed" | "temporaryClosedReason" | "businessHours">;

/** 2026-06-15 는 월요일. 요일 인덱스 1. */
const at = (hhmm: string, date = "2026-06-15") => new Date(`${date}T${hhmm}:00`);

type DaySpec = NonNullable<BusinessHours["weekly"]>[number];

function weekly(day: number, spec: Partial<DaySpec>): BusinessHours {
  const base = defaultBusinessHours();
  const days = base.weekly ?? [];
  days[day] = { ...days[day], ...spec };
  return { ...base, weekly: days };
}

describe("getStoreOpenStatus — 우선순위", () => {
  it("소유자 정보가 없으면 막지 않는다", () => {
    expect(getStoreOpenStatus(null).open).toBe(true);
    expect(getStoreOpenStatus(undefined).open).toBe(true);
  });

  it("임시 마감이 영업시간보다 우선한다", () => {
    const owner: Owner = {
      temporarilyClosed: true,
      businessHours: { ...defaultBusinessHours(), open24h: true },
    };
    const s = getStoreOpenStatus(owner, at("12:00"));
    expect(s.open).toBe(false);
  });

  it("임시 마감 사유를 그대로 전달한다", () => {
    const owner: Owner = { temporarilyClosed: true, temporaryClosedReason: "재료 소진" };
    expect(getStoreOpenStatus(owner, at("12:00"))).toMatchObject({
      open: false,
      reason: "재료 소진",
    });
  });

  it("영업시간 미설정이면 항상 영업 중이다", () => {
    expect(getStoreOpenStatus({ businessHours: undefined }, at("03:00")).open).toBe(true);
  });

  it("24시간 영업은 새벽에도 열려 있다", () => {
    const owner: Owner = { businessHours: { ...defaultBusinessHours(), open24h: true } };
    expect(getStoreOpenStatus(owner, at("03:00")).open).toBe(true);
  });
});

describe("getStoreOpenStatus — 휴무", () => {
  it("지정 휴무일이면 닫는다", () => {
    const bh = { ...defaultBusinessHours(), closedDates: ["2026-06-15"] };
    expect(getStoreOpenStatus({ businessHours: bh }, at("12:00")).open).toBe(false);
  });

  it("다른 날짜의 휴무는 영향이 없다", () => {
    const bh = weekly(1, { closed: false, open: "09:00", close: "22:00" });
    bh.closedDates = ["2026-06-16"];
    expect(getStoreOpenStatus({ businessHours: bh }, at("12:00")).open).toBe(true);
  });

  it("요일 휴무면 닫는다", () => {
    const bh = weekly(1, { closed: true });
    expect(getStoreOpenStatus({ businessHours: bh }, at("12:00")).open).toBe(false);
  });
});

describe("getStoreOpenStatus — 영업 시간대", () => {
  const bh = weekly(1, { closed: false, open: "09:00", close: "22:00" });

  it("영업 시간 안이면 열려 있다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("09:00")).open).toBe(true);
    expect(getStoreOpenStatus({ businessHours: bh }, at("15:30")).open).toBe(true);
    expect(getStoreOpenStatus({ businessHours: bh }, at("21:59")).open).toBe(true);
  });

  it("마감 시각 정각은 닫힌 것으로 본다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("22:00")).open).toBe(false);
  });

  it("개점 전이면 개점 시각을 알려준다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("08:00"))).toMatchObject({
      open: false,
      from: "09:00",
    });
  });
});

describe("getStoreOpenStatus — 자정을 넘는 영업", () => {
  // 09:00~02:00 같은 심야 영업. closeM <= openM 분기가 여기서 걸린다.
  const bh = weekly(1, { closed: false, open: "21:00", close: "02:00" });

  it("개점 후 자정 전이면 열려 있다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("23:00")).open).toBe(true);
  });

  it("자정을 넘긴 새벽도 열려 있다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("01:00")).open).toBe(true);
  });

  it("마감 후 낮 시간은 닫혀 있다", () => {
    expect(getStoreOpenStatus({ businessHours: bh }, at("03:00")).open).toBe(false);
    expect(getStoreOpenStatus({ businessHours: bh }, at("14:00")).open).toBe(false);
  });
});

describe("getStoreOpenStatus — 휴게시간", () => {
  it("휴게시간이면 닫힌 것으로 본다", () => {
    const bh = weekly(1, { closed: false, open: "09:00", close: "22:00", breakStart: "15:00", breakEnd: "17:00" });
    expect(getStoreOpenStatus({ businessHours: bh }, at("16:00")).open).toBe(false);
    expect(getStoreOpenStatus({ businessHours: bh }, at("14:59")).open).toBe(true);
    expect(getStoreOpenStatus({ businessHours: bh }, at("17:00")).open).toBe(true);
  });

  it("자정을 넘는 휴게시간도 처리한다", () => {
    const bh = weekly(1, { closed: false, open: "21:00", close: "05:00", breakStart: "23:30", breakEnd: "00:30" });
    expect(getStoreOpenStatus({ businessHours: bh }, at("23:45")).open).toBe(false);
    expect(getStoreOpenStatus({ businessHours: bh }, at("22:00")).open).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  TIER_ORDER,
  getCustomerTier,
  getNextTier,
  getEffectiveTier,
  calculateRFM,
  getRFMCluster,
} from "./tier";
import type { Visit } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T12:00:00Z").getTime();

/** 방문 레코드 최소 형태 — 등급 계산이 보는 필드만 채운다. */
function visit(daysAgo: number, totalAmount = 10000): Visit {
  return {
    date: new Date(NOW - daysAgo * DAY).toISOString(),
    totalAmount,
  } as Visit;
}

describe("getCustomerTier", () => {
  it("방문 횟수 경계에서 등급이 바뀐다", () => {
    expect(getCustomerTier(0)).toBe("일반");
    expect(getCustomerTier(1)).toBe("일반");
    expect(getCustomerTier(2)).toBe("브론즈");
    expect(getCustomerTier(3)).toBe("브론즈");
    expect(getCustomerTier(4)).toBe("실버");
    expect(getCustomerTier(6)).toBe("골드");
    expect(getCustomerTier(8)).toBe("다이아");
    expect(getCustomerTier(12)).toBe("VIP");
    expect(getCustomerTier(9999)).toBe("VIP");
  });

  it("방문이 늘어도 등급이 내려가지 않는다 (단조 증가)", () => {
    let prev = -1;
    for (let n = 0; n <= 30; n++) {
      const idx = TIER_ORDER.indexOf(getCustomerTier(n));
      expect(idx).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });
});

describe("getNextTier", () => {
  it("다음 등급과 필요 방문 수를 알려준다", () => {
    expect(getNextTier("일반")).toEqual({ tier: "브론즈", min: 2 });
    expect(getNextTier("골드")).toEqual({ tier: "다이아", min: 8 });
  });

  it("최상위 등급은 다음이 없다", () => {
    expect(getNextTier("VIP")).toBeNull();
  });
});

describe("getEffectiveTier", () => {
  it("수동 지정 등급이 자동 계산을 이긴다", () => {
    expect(getEffectiveTier(0, "VIP")).toBe("VIP");
    expect(getEffectiveTier(99, "일반")).toBe("일반");
  });

  it("auto / 미지정이면 방문 기반으로 계산한다", () => {
    expect(getEffectiveTier(6, "auto")).toBe("골드");
    expect(getEffectiveTier(6, null)).toBe("골드");
    expect(getEffectiveTier(6)).toBe("골드");
  });
});

describe("calculateRFM", () => {
  it("방문이 없으면 최하 점수다", () => {
    expect(calculateRFM([], NOW)).toEqual({ r: 1, f: 1, m: 1 });
  });

  it("R — 마지막 방문이 최근일수록 높다", () => {
    expect(calculateRFM([visit(1)], NOW).r).toBe(5);
    expect(calculateRFM([visit(10)], NOW).r).toBe(4);
    expect(calculateRFM([visit(20)], NOW).r).toBe(3);
    expect(calculateRFM([visit(45)], NOW).r).toBe(2);
    expect(calculateRFM([visit(120)], NOW).r).toBe(1);
  });

  it("R 은 가장 최근 방문만 본다", () => {
    // 오래된 방문이 섞여 있어도 최근 방문이 있으면 R 은 높아야 한다
    expect(calculateRFM([visit(300), visit(1), visit(200)], NOW).r).toBe(5);
  });

  it("F — 방문 횟수 구간을 따른다", () => {
    const mk = (n: number) => Array.from({ length: n }, () => visit(1));
    expect(calculateRFM(mk(1), NOW).f).toBe(1);
    expect(calculateRFM(mk(2), NOW).f).toBe(2);
    expect(calculateRFM(mk(3), NOW).f).toBe(3);
    expect(calculateRFM(mk(5), NOW).f).toBe(4);
    expect(calculateRFM(mk(10), NOW).f).toBe(5);
  });

  it("M — 방문당 평균 결제액 구간을 따른다", () => {
    expect(calculateRFM([visit(1, 5000)], NOW).m).toBe(1);
    expect(calculateRFM([visit(1, 8000)], NOW).m).toBe(2);
    expect(calculateRFM([visit(1, 15000)], NOW).m).toBe(3);
    expect(calculateRFM([visit(1, 30000)], NOW).m).toBe(4);
    expect(calculateRFM([visit(1, 50000)], NOW).m).toBe(5);
  });

  it("M 은 합계가 아니라 평균을 본다", () => {
    // 1만원 10회 = 10만원이지만 평균은 1만원 → 상위 구간이 아니다
    const many = Array.from({ length: 10 }, () => visit(1, 10000));
    expect(calculateRFM(many, NOW).m).toBe(2);
  });

  it("totalAmount 누락을 0 으로 다룬다", () => {
    const noAmount = [{ date: new Date(NOW - DAY).toISOString() } as Visit];
    expect(calculateRFM(noAmount, NOW).m).toBe(1);
  });
});

describe("getRFMCluster", () => {
  it("최근+자주 = vip", () => {
    expect(getRFMCluster({ r: 5, f: 5, m: 3 }).id).toBe("vip");
  });

  it("자주+고액이지만 뜸해지면 whale", () => {
    expect(getRFMCluster({ r: 3, f: 4, m: 5 }).id).toBe("whale");
  });

  it("최근에 왔지만 방문이 적으면 new", () => {
    expect(getRFMCluster({ r: 5, f: 1, m: 1 }).id).toBe("new");
  });

  it("자주 왔는데 발길이 끊기면 slipping", () => {
    expect(getRFMCluster({ r: 2, f: 5, m: 2 }).id).toBe("slipping");
  });

  it("아주 오래 안 오면 cold", () => {
    expect(getRFMCluster({ r: 1, f: 2, m: 2 }).id).toBe("cold");
  });

  it("그 외는 regular", () => {
    expect(getRFMCluster({ r: 3, f: 3, m: 3 }).id).toBe("regular");
  });

  it("모든 RFM 조합에 클러스터가 배정된다", () => {
    const ok = new Set(["vip", "whale", "new", "slipping", "cold", "regular"]);
    for (let r = 1; r <= 5; r++)
      for (let f = 1; f <= 5; f++)
        for (let m = 1; m <= 5; m++) {
          const c = getRFMCluster({ r, f, m } as never);
          expect(ok.has(c.id)).toBe(true);
        }
  });
});

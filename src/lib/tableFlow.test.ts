import { describe, it, expect } from "vitest";
import {
  normalizeStatus,
  STATUS_LABEL_KEY,
  STATUS_BADGE,
  STATUS_ORDER,
  STATUS_STEP,
  nextManualTransitions,
} from "./tableFlow";
import type { TableStatus } from "./types";

const ALL: TableStatus[] = [
  "available", "reserved", "setup", "occupied", "dining", "paid", "cleaning", "dirty",
];

describe("normalizeStatus", () => {
  it("legacy 'dirty' 를 'cleaning' 으로 접는다", () => {
    expect(normalizeStatus("dirty")).toBe("cleaning");
  });

  it("알려진 상태는 그대로 둔다", () => {
    for (const s of ALL.filter((s) => s !== "dirty")) {
      expect(normalizeStatus(s)).toBe(s);
    }
  });

  it("빈 값·미상 값은 available 로 떨어진다", () => {
    expect(normalizeStatus(null)).toBe("available");
    expect(normalizeStatus(undefined)).toBe("available");
    expect(normalizeStatus("")).toBe("available");
    expect(normalizeStatus("garbage")).toBe("available");
  });

  it("멱등이다", () => {
    for (const s of ALL) {
      expect(normalizeStatus(normalizeStatus(s))).toBe(normalizeStatus(s));
    }
  });
});

describe("상태 테이블 무결성", () => {
  // 화면 3곳(대시보드·테이블편집·손님화면)이 이 표를 공유한다. 구멍이 나면 빈 배지가 뜬다.
  it("모든 상태에 라벨 키가 있다", () => {
    for (const s of ALL) expect(STATUS_LABEL_KEY[s]).toBeTruthy();
  });

  it("모든 상태에 배지 색이 있다", () => {
    for (const s of ALL) {
      expect(STATUS_BADGE[s]?.bg).toBeTruthy();
      expect(STATUS_BADGE[s]?.text).toBeTruthy();
      expect(STATUS_BADGE[s]?.dot).toBeTruthy();
    }
  });

  it("모든 상태에 정렬 순서와 단계가 있다", () => {
    for (const s of ALL) {
      expect(typeof STATUS_ORDER[s]).toBe("number");
      expect(typeof STATUS_STEP[s]).toBe("number");
    }
  });

  it("legacy dirty 는 cleaning 과 같은 순서·단계를 쓴다", () => {
    expect(STATUS_ORDER.dirty).toBe(STATUS_ORDER.cleaning);
    expect(STATUS_STEP.dirty).toBe(STATUS_STEP.cleaning);
  });
});

describe("nextManualTransitions", () => {
  it("available 은 예약과 세팅으로 갈라진다", () => {
    expect(nextManualTransitions("available").map((x) => x.to)).toEqual(["reserved", "setup"]);
  });

  it("paid 는 청소로만 간다", () => {
    expect(nextManualTransitions("paid").map((x) => x.to)).toEqual(["cleaning"]);
  });

  it("청소가 끝나면 available 로 돌아온다", () => {
    expect(nextManualTransitions("cleaning").map((x) => x.to)).toEqual(["available"]);
  });

  it("legacy dirty 는 cleaning 과 같은 전이를 낸다", () => {
    expect(nextManualTransitions("dirty").map((x) => x.to)).toEqual(
      nextManualTransitions("cleaning").map((x) => x.to)
    );
  });

  it("접객 중(occupied/dining)은 수동 전이가 없다 — 결제·퇴장은 별도 액션", () => {
    expect(nextManualTransitions("occupied")).toEqual([]);
    expect(nextManualTransitions("dining")).toEqual([]);
  });

  it("모든 전이 대상이 유효한 상태다", () => {
    for (const s of ALL) {
      for (const tr of nextManualTransitions(s)) {
        expect(ALL).toContain(tr.to);
        expect(tr.label).toBeTruthy();
      }
    }
  });
});

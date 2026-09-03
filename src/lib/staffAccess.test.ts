import { describe, it, expect } from "vitest";
import {
  STAFF_FEATURES,
  STAFF_LEVELS,
  normalizeStaffPath,
  staffMinLevel,
  canStaffAccess,
  PERM_MANAGE_STAFF,
} from "./staffAccess";
import type { StaffLevel } from "./types";

describe("normalizeStaffPath", () => {
  // 정규화가 없으면 lv1 직원이 '/biz/owner/settlement/' 같은 변형 URL 로
  // 등급 가드를 그냥 통과한다(권한 상승). 그래서 이건 보안 경계다.
  it("트레일링 슬래시를 제거한다", () => {
    expect(normalizeStaffPath("/biz/owner/settlement/")).toBe("/biz/owner/settlement");
    expect(normalizeStaffPath("/biz/owner/settlement///")).toBe("/biz/owner/settlement");
  });

  it("대소문자를 접는다", () => {
    expect(normalizeStaffPath("/BIZ/Owner/Settlement")).toBe("/biz/owner/settlement");
  });

  it("루트는 슬래시를 남긴다", () => {
    expect(normalizeStaffPath("/")).toBe("/");
  });
});

describe("staffMinLevel", () => {
  it("등록된 경로의 최소 등급을 돌려준다", () => {
    expect(staffMinLevel("/biz/owner/orders")).toBe(1);
    expect(staffMinLevel("/biz/owner/customers")).toBe(2);
    expect(staffMinLevel("/biz/owner/statistics")).toBe(3);
    expect(staffMinLevel("/biz/owner/settlement")).toBe(4);
  });

  it("사장 전용 경로는 undefined 다", () => {
    // 목록에 없는 경로 = 직원에게 절대 열리지 않음
    expect(staffMinLevel("/biz/owner/brand-settings")).toBeUndefined();
    expect(staffMinLevel("/biz/owner/kiosk")).toBeUndefined();
    expect(staffMinLevel("/biz/owner")).toBeUndefined();
  });

  it("[보안] 경로 변형으로 조회를 우회할 수 없다", () => {
    for (const variant of [
      "/biz/owner/settlement/",
      "/BIZ/OWNER/SETTLEMENT",
      "/biz/owner/Settlement//",
    ]) {
      expect(staffMinLevel(variant)).toBe(4);
    }
  });
});

describe("canStaffAccess", () => {
  it("등급이 최소 등급 이상이면 허용한다", () => {
    expect(canStaffAccess("/biz/owner/orders", 1)).toBe(true);
    expect(canStaffAccess("/biz/owner/customers", 2)).toBe(true);
    expect(canStaffAccess("/biz/owner/settlement", 4)).toBe(true);
  });

  it("등급이 모자라면 거부한다", () => {
    expect(canStaffAccess("/biz/owner/customers", 1)).toBe(false);
    expect(canStaffAccess("/biz/owner/statistics", 2)).toBe(false);
    expect(canStaffAccess("/biz/owner/settlement", 3)).toBe(false);
  });

  it("상위 등급은 하위 기능을 누적 포함한다", () => {
    for (const f of STAFF_FEATURES) {
      for (const lv of STAFF_LEVELS) {
        expect(canStaffAccess(f.path, lv)).toBe(lv >= f.minLevel);
      }
    }
  });

  it("사장님 개별 허용(extraPerms)은 등급을 넘어선다", () => {
    expect(canStaffAccess("/biz/owner/settlement", 1)).toBe(false);
    expect(canStaffAccess("/biz/owner/settlement", 1, ["/biz/owner/settlement"])).toBe(true);
  });

  it("[보안] extraPerms 로도 사장 전용 경로는 열리지 않는다", () => {
    // 목록에 없는 경로는 need == null 로 즉시 거부 — extraPerms 가 있어도 마찬가지
    expect(canStaffAccess("/biz/owner/brand-settings", 4, ["/biz/owner/brand-settings"])).toBe(false);
  });

  it("[보안] 변형 경로로 등급 가드를 우회할 수 없다", () => {
    expect(canStaffAccess("/biz/owner/settlement/", 1)).toBe(false);
    expect(canStaffAccess("/BIZ/OWNER/SETTLEMENT", 1)).toBe(false);
  });

  it("extraPerms 는 정규화된 경로로 매칭된다", () => {
    expect(canStaffAccess("/biz/owner/settlement/", 1, ["/biz/owner/settlement"])).toBe(true);
  });
});

describe("STAFF_FEATURES 무결성", () => {
  it("경로가 중복되지 않는다", () => {
    const paths = STAFF_FEATURES.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("모든 경로가 이미 정규형이다", () => {
    // 표에 비정규형이 섞이면 Map 조회가 조용히 빗나가 권한이 뚫린다
    for (const f of STAFF_FEATURES) {
      expect(f.path).toBe(normalizeStaffPath(f.path));
    }
  });

  it("minLevel 이 유효 등급 범위 안에 있다", () => {
    for (const f of STAFF_FEATURES) {
      expect(STAFF_LEVELS).toContain(f.minLevel as StaffLevel);
    }
  });
});

describe("위임 권한 토큰", () => {
  it("라우트 가드에 영향을 주지 않는다", () => {
    // PERM_MANAGE_STAFF 는 '능력' 토큰이지 경로가 아니다
    expect(staffMinLevel(PERM_MANAGE_STAFF)).toBeUndefined();
    expect(canStaffAccess(PERM_MANAGE_STAFF, 4, [PERM_MANAGE_STAFF])).toBe(false);
  });
});

// @vitest-environment jsdom
import React from "react";
import { render, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DB 에 실제로 붙지 않는다. 이 테스트가 검증하는 건 "Provider 가 노출하는
// 계약(Context 표면)"이지 네트워크 동작이 아니다.
// isSupabaseConfigured 를 false 로 두면 Provider 가 오프라인 경로로 부팅한다.
vi.mock("../lib/supabase", () => ({
  isSupabaseConfigured: false,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => ({ select: () => ({ eq: () => ({}) }) }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
    rpc: async () => ({ error: null }),
  },
  resolveTable: (n: string) => n,
  SUPABASE_URL: "",
  SUPABASE_PUBLISHABLE_KEY: "",
}));

import { StoreProvider, useStore } from "./store";

/** Provider 가 실제로 넘겨주는 context 값을 한 번 낚아채는 프로브. */
function captureStore(): Record<string, unknown> {
  let captured: Record<string, unknown> | null = null;
  function Probe() {
    captured = useStore() as unknown as Record<string, unknown>;
    return null;
  }
  act(() => {
    render(
      <StoreProvider>
        <Probe />
      </StoreProvider>
    );
  });
  if (!captured) throw new Error("useStore() 값을 캡처하지 못했다");
  return captured;
}

/** 함수가 아닌(=상태) 키. 나머지 전부는 액션이며 함수여야 한다. */
const DATA_KEYS = [
  "activeShift", "activeStoreId", "communications", "coupons", "currentUser",
  "effectiveStoreId", "expenses", "dbError", "dbStatus", "ingredients",
  "isMaster", "isReady", "marketingDrafts", "masterPassword", "menus", "orders",
  "photos", "reservations", "sections", "shifts", "tables", "tierOverrides",
  "users", "visits",
];

/**
 * StoreProvider 가 노출해야 하는 전체 표면 (실행 결과로 캡처한 골든).
 *
 * store.tsx 분해(2,547줄 → 도메인 훅) 이전에 고정해 둔 목록이다. 화면 수백 개가
 * 이 이름들로 useStore() 를 호출하므로, 분해 과정에서 하나라도 빠지거나 오타가 나면
 * 런타임에서야 "is not a function" 으로 터진다. 여기서 먼저 깨지게 한다.
 */
const EXPECTED_KEYS = [
  ...DATA_KEYS,
  "addExpense", "addIngredient", "addMarketingDraft", "addMenuItem", "addPhoto",
  "addReservation", "addSection", "addTable", "approveCouponUse", "approvePayment",
  "approveStaff", "bulkIssueCoupon", "cancelCouponRequest", "cancelJoinRequest",
  "clockIn", "clockOut", "completeTable", "confirmTossPayment", "deleteAccount",
  "deleteExpense", "deleteIngredient", "deleteMarketingDraft", "deleteMenuItem",
  "deletePhoto", "deleteReservation", "deleteSection", "deleteTable", "deleteUser",
  "enterTable", "evictTable", "initTables", "issueCoupon", "leaveTable", "login",
  "loginMaster", "logout", "logoutMaster", "markPhoneVerified", "moveOrdersTable",
  "payTableSession", "placeOrder", "printInterimReceipt", "recordCommunication",
  "recordVisit", "rejectCouponUse", "rejectStaff", "removeStaffMembership",
  "requestCouponUse", "requestJoinStore", "reviewMarketingDraft", "setActiveStoreId",
  "setCustomerTier", "setMasterPassword", "setStaffLevel", "setStaffPerms",
  "setStaffWage", "updateBrandSettings", "updateIngredient",
  "updateMarketingDraftContent", "updateMenuItem", "updateOrderStatus", "updatePhoto",
  "updateReservation", "updateSection", "updateStoreConfig", "updateStoreLocation",
  "updateTableLayout", "updateTableStatus", "updateUserMemo",
];

describe("StoreProvider 계약", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("[회귀] 분해 전과 동일한 키 집합을 노출한다", () => {
    expect(Object.keys(captureStore()).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it("상태가 아닌 키는 전부 함수다 — 이름만 있고 undefined 인 배선 누락을 잡는다", () => {
    const store = captureStore();
    const data = new Set(DATA_KEYS);
    const broken = EXPECTED_KEYS.filter((k) => !data.has(k) && typeof store[k] !== "function");
    expect(broken).toEqual([]);
  });

  it("Firebase 미구성 상태에서도 컬렉션은 빈 배열로 시작한다", () => {
    const store = captureStore();
    for (const k of ["users", "visits", "coupons", "tables", "sections", "menus", "orders",
                     "reservations", "photos", "shifts", "ingredients", "expenses",
                     "marketingDrafts", "communications", "tierOverrides"]) {
      expect(Array.isArray(store[k]), `${k} 는 배열이어야 한다`).toBe(true);
    }
    expect(store.currentUser).toBe(null);
    expect(store.isMaster).toBe(false);
    expect(store.masterPassword).toBe("IMC");
  });
});

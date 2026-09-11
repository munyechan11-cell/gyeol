import React, { createContext, useContext, useMemo } from "react";

import { useStoreCore } from "./core";
import { useStoreSubscriptions } from "./subscriptions";
import { useAuthActions } from "./actions/auth";
import { useCustomerActions } from "./actions/customers";
import { useInventoryActions } from "./actions/inventory";
import { useTableActions } from "./actions/tables";
import { useCouponActions } from "./actions/coupons";
import { useMenuActions } from "./actions/menu";
import { useMarketingActions } from "./actions/marketing";
import { useOrderActions } from "./actions/orders";
import { useSettingsActions } from "./actions/settings";
import { useReservationActions } from "./actions/reservations";
import { useStaffActions } from "./actions/staff";
import type { StoreState } from "./types";

export type { StoreState } from "./types";

const StoreCtx = createContext<StoreState | null>(null);

/**
 * 결 전역 스토어 — 합성 루트.
 *
 * 상태는 useStoreCore, Firestore 구독은 useStoreSubscriptions, 나머지는 전부
 * 도메인별 액션 훅이 담당한다. 이 파일에는 "무엇을 조립해 context 로 내보내는가"만 둔다.
 *
 * 훅 호출 순서 = effect 등록 순서다. core(상태 미러링) → subscriptions(구독) →
 * actions(useCallback 만, effect 없음) 순서를 유지할 것.
 */
export function StoreProvider({ children }: { children: React.ReactNode }) {
  const core = useStoreCore();
  useStoreSubscriptions(core);

  const {
    isReady, dbStatus, dbError, currentUser, masterPassword, isMaster,
    users, visits, coupons, tables, sections, communications, tierOverrides, menus,
    orders, reservations, photos, shifts, ingredients, expenses, marketingDrafts,
    activeStoreId, setActiveStoreId, effectiveStoreId,
  } = core;

  const {
    login, logout, deleteAccount, setMasterPassword, markPhoneVerified,
    loginMaster, logoutMaster, deleteUser,
  } = useAuthActions(core);

  const {
    recordVisit, recordCommunication, updateUserMemo, setCustomerTier, bulkIssueCoupon,
  } = useCustomerActions(core);

  // 재고 차감은 테이블 정리(evictTable)와 주문(placeOrder/취소) 양쪽에서 쓰인다.
  // 두 도메인이 같은 구현을 공유하도록 여기서 한 번만 만들어 내려보낸다.
  const {
    addIngredient, updateIngredient, deleteIngredient, addExpense, deleteExpense,
    adjustStockForOrder,
  } = useInventoryActions(core);

  const {
    leaveTable, enterTable, evictTable, addTable, updateTableLayout, deleteTable,
    updateTableStatus, initTables, addSection, updateSection, deleteSection, completeTable,
  } = useTableActions(core, { adjustStockForOrder });

  const {
    issueCoupon, requestCouponUse, cancelCouponRequest, approveCouponUse, rejectCouponUse,
  } = useCouponActions(core);

  const { addMenuItem, updateMenuItem, deleteMenuItem } = useMenuActions(core);

  const {
    addMarketingDraft, reviewMarketingDraft, updateMarketingDraftContent,
    deleteMarketingDraft, addPhoto, updatePhoto, deletePhoto,
  } = useMarketingActions(core);

  const {
    placeOrder, updateOrderStatus, payTableSession, confirmTossPayment, approvePayment,
    printInterimReceipt, moveOrdersTable,
  } = useOrderActions(core, { adjustStockForOrder });

  const { updateBrandSettings, updateStoreConfig, updateStoreLocation } = useSettingsActions(core);

  const { addReservation, updateReservation, deleteReservation } = useReservationActions(core);

  const {
    setStaffWage, setStaffLevel, setStaffPerms, requestJoinStore, cancelJoinRequest,
    approveStaff, rejectStaff, removeStaffMembership, clockIn, clockOut, activeShift,
  } = useStaffActions(core);


  const value = useMemo<StoreState>(
    () => ({
      isReady,
      dbStatus,
      dbError,
      currentUser,
      masterPassword,
      isMaster,
      users,
      visits,
      coupons,
      tables,
      sections,
      communications,
      tierOverrides,
      menus,
      orders,
      reservations,
      photos,
      shifts,
      ingredients,
      expenses,
      marketingDrafts,
      activeShift,
      effectiveStoreId,
      activeStoreId,
      setActiveStoreId,
      login,
      logout,
      deleteAccount,
      setMasterPassword,
      markPhoneVerified,
      loginMaster,
      logoutMaster,
      deleteUser,
      recordVisit,
      leaveTable,
      enterTable,
      evictTable,
      issueCoupon,
      requestCouponUse,
      cancelCouponRequest,
      approveCouponUse,
      rejectCouponUse,
      addTable,
      updateTableLayout,
      deleteTable,
      updateTableStatus,
      initTables,
      addSection,
      updateSection,
      deleteSection,
      addMenuItem,
      updateMenuItem,
      deleteMenuItem,
      placeOrder,
      updateOrderStatus,
      payTableSession,
      approvePayment,
      moveOrdersTable,
      confirmTossPayment,
      completeTable,
      printInterimReceipt,
      recordCommunication,
      updateUserMemo,
      setStaffWage,
      setStaffLevel,
      setStaffPerms,
      setCustomerTier,
      bulkIssueCoupon,
      updateBrandSettings,
      updateStoreConfig,
      updateStoreLocation,
      addReservation,
      updateReservation,
      deleteReservation,
      addPhoto,
      updatePhoto,
      deletePhoto,
      addIngredient,
      updateIngredient,
      deleteIngredient,
      addExpense,
      deleteExpense,
      addMarketingDraft,
      reviewMarketingDraft,
      updateMarketingDraftContent,
      deleteMarketingDraft,
      requestJoinStore,
      cancelJoinRequest,
      approveStaff,
      rejectStaff,
      removeStaffMembership,
      clockIn,
      clockOut,
    }),
    [
      isReady,
      dbStatus,
      dbError,
      currentUser,
      masterPassword,
      isMaster,
      users,
      visits,
      coupons,
      tables,
      sections,
      communications,
      tierOverrides,
      menus,
      orders,
      reservations,
      photos,
      shifts,
      ingredients,
      expenses,
      marketingDrafts,
      activeShift,
      effectiveStoreId,
      activeStoreId,
      login,
      logout,
      deleteAccount,
      setMasterPassword,
      markPhoneVerified,
      loginMaster,
      logoutMaster,
      deleteUser,
      recordVisit,
      leaveTable,
      enterTable,
      evictTable,
      issueCoupon,
      requestCouponUse,
      cancelCouponRequest,
      approveCouponUse,
      rejectCouponUse,
      addTable,
      updateTableLayout,
      deleteTable,
      updateTableStatus,
      initTables,
      addSection,
      updateSection,
      deleteSection,
      addMenuItem,
      updateMenuItem,
      deleteMenuItem,
      placeOrder,
      updateOrderStatus,
      payTableSession,
      approvePayment,
      moveOrdersTable,
      confirmTossPayment,
      completeTable,
      printInterimReceipt,
      recordCommunication,
      updateUserMemo,
      setStaffWage,
      setStaffLevel,
      setStaffPerms,
      setCustomerTier,
      bulkIssueCoupon,
      updateBrandSettings,
      updateStoreConfig,
      updateStoreLocation,
      addReservation,
      updateReservation,
      deleteReservation,
      addPhoto,
      updatePhoto,
      deletePhoto,
      addIngredient,
      updateIngredient,
      deleteIngredient,
      addExpense,
      deleteExpense,
      addMarketingDraft,
      reviewMarketingDraft,
      updateMarketingDraftContent,
      deleteMarketingDraft,
      requestJoinStore,
      cancelJoinRequest,
      approveStaff,
      rejectStaff,
      removeStaffMembership,
      clockIn,
      clockOut,
    ]
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be inside StoreProvider");
  return ctx;
}

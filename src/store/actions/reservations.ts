import { newId, removeDoc, saveDoc } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import type { Reservation } from "../../lib/types";

export function useReservationActions(core: StoreCore) {
  const { tables, reservations, tablesRef, reservationsRef } = core;


  // ============ RESERVATIONS ============
  /**
   * 예약 → 테이블 자동 reserved 전이 정책 (2026-06).
   * - 예약 추가: 해당 테이블이 available/reserved 이면 reserved 로 변경.
   *   (이미 occupied/dining/paid/cleaning 인 경우엔 덮어쓰지 않음)
   * - 예약 취소/완료/노쇼/삭제: 해당 테이블이 reserved 이고 활성 예약이 더 없으면
   *   available 로 복귀. 손님이 이미 들어와 있으면 그대로 둠.
   */
  const _activeReservationsFor = (storeId: string, tableNumber: number, excludeId?: string) => {
    // 로컬(매장) 자정 기준 오늘 — toISOString 은 UTC라 KST 새벽엔 날짜가 하루 밀려
    // 어제 예약이 계속 활성으로 잡혀 테이블이 '예약됨'에서 안 풀리던 버그가 있었음.
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    return reservationsRef.current.filter(
      (r) =>
        r.id !== excludeId &&
        r.storeId === storeId &&
        r.tableNumber === tableNumber &&
        r.status === "confirmed" &&
        r.date >= today
    );
  };

  const _refreshReservedForTable = useCallback(
    async (storeId: string, tableNumber: number, excludeId?: string) => {
      if (!storeId || !tableNumber) return;
      const tableId = `${storeId}_${tableNumber}`;
      const t = tablesRef.current.find((x) => x.id === tableId);
      if (!t) return;
      const still = _activeReservationsFor(storeId, tableNumber, excludeId).length > 0;
      // 현재 reserved 이고 더 이상 예약이 없으면 available 로 복귀
      if (t.status === "reserved" && !still) {
        await saveDoc("tables", tableId, {
          status: "available",
          // 점유 정보는 안 건드림 (예약은 점유와 별개)
        });
      }
    },
    []
  );

  const addReservation = useCallback(
    async (
      input: Omit<Reservation, "id" | "createdAt" | "status"> & { status?: Reservation["status"] }
    ) => {
      const r: Reservation = {
        id: newId(),
        createdAt: new Date().toISOString(),
        status: input.status ?? "confirmed",
        ...input,
      };
      await saveDoc("reservations", r.id, r);

      // 8단계 자동 전이 — 예약 추가 시 테이블 reserved 로 (점유 중이면 보호)
      try {
        if (r.status === "confirmed") {
          const tableId = `${r.storeId}_${r.tableNumber}`;
          const t = tablesRef.current.find((x) => x.id === tableId);
          const cur = t?.status;
          // available 또는 setup, reserved 일 때만 reserved 로 (그 외는 보호)
          if (!cur || cur === "available" || cur === "setup" || cur === "reserved") {
            await saveDoc("tables", tableId, { status: "reserved" });
          }
        }
      } catch (e: any) {
        console.warn("[addReservation] status→reserved skip", e?.message);
      }

      showToast(t("store.reservation.added"), "success");
    },
    []
  );

  const updateReservation = useCallback(async (id: string, data: Partial<Reservation>) => {
    const before = reservationsRef.current.find((r) => r.id === id);
    await saveDoc("reservations", id, data);
    if (!before) return;
    const merged = { ...before, ...data };
    // 예약이 비활성화(cancelled/completed/no-show) 되었거나 다른 테이블·날짜로 이동했으면
    // 원래 테이블의 reserved 상태를 갱신해야 함.
    const becameInactive =
      before.status === "confirmed" && merged.status && merged.status !== "confirmed";
    const movedTable =
      merged.tableNumber !== undefined && merged.tableNumber !== before.tableNumber;
    if (becameInactive || movedTable) {
      await _refreshReservedForTable(before.storeId, before.tableNumber, id);
    }
    // 다른 테이블로 이동한 경우 새 테이블도 reserved 로 (활성 예약일 때만)
    if (movedTable && merged.status !== "cancelled" && merged.status !== "no-show") {
      const newTableId = `${before.storeId}_${merged.tableNumber}`;
      const t = tablesRef.current.find((x) => x.id === newTableId);
      const cur = t?.status;
      if (!cur || cur === "available" || cur === "setup" || cur === "reserved") {
        await saveDoc("tables", newTableId, { status: "reserved" });
      }
    }
  }, [_refreshReservedForTable]);

  const deleteReservation = useCallback(async (id: string) => {
    const before = reservationsRef.current.find((r) => r.id === id);
    await removeDoc("reservations", id);
    if (before) {
      await _refreshReservedForTable(before.storeId, before.tableNumber, id);
    }
  }, [_refreshReservedForTable]);

  return { addReservation, updateReservation, deleteReservation };
}

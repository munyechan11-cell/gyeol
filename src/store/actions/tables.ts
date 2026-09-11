import { newId, removeDoc, saveDoc, saveDocs } from "../../lib/db";
import type { StoreCore } from "../core";
import type { AdjustStock } from "./inventory";
import { makeDefaultTables } from "../constants";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import type { TableDoc, Section, TableStatus } from "../../lib/types";

export function useTableActions(core: StoreCore, deps: { adjustStockForOrder: AdjustStock }) {
  const { tables, sections, orders, tablesRef, ordersRef } = core;
  const { adjustStockForOrder } = deps;


  const leaveTable = useCallback(async (tableNumber: number, storeId: string) => {
    const tableId = `${storeId}_${tableNumber}`;
    await saveDoc("tables", tableId, {
      currentCustomerId: null,
      occupantIds: [],
      currentCustomerName: null,
      partySize: null,
      sessionStartTime: null,
      status: "dirty",
    });
  }, []);

  /**
   * 손님이 QR 로 매장 진입 — 테이블 점유 시작.
   * 이미 점유 상태면 추가 손님으로 occupantIds 에 합석.
   * 호출처: customer/TableEntry.tsx (또는 customer/Dashboard.tsx 진입 시점)
   */
  const enterTable = useCallback(
    async (input: {
      tableNumber: number;
      storeId: string;
      customerId: string;
      customerName?: string;
      partySize?: number;
    }) => {
      const tableId = `${input.storeId}_${input.tableNumber}`;
      const existing = tablesRef.current.find((t) => t.id === tableId);
      const occupantIds = Array.from(
        new Set([...(existing?.occupantIds ?? []), input.customerId])
      );
      // 8단계 자동 전이 — 현재 status 가 setup/reserved/available 이었으면 occupied 로
      // 이미 occupied/dining/paid 면 유지 (합석/주문 후 점유 갱신)
      const cur = existing?.status;
      const nextStatus =
        cur === "dining" || cur === "paid" || cur === "cleaning" || cur === "dirty"
          ? cur
          : "occupied";
      await saveDoc("tables", tableId, {
        currentCustomerId: existing?.currentCustomerId ?? input.customerId,
        currentCustomerName: existing?.currentCustomerName ?? input.customerName ?? null,
        occupantIds,
        partySize: input.partySize ?? existing?.partySize ?? occupantIds.length,
        sessionStartTime: existing?.sessionStartTime ?? new Date().toISOString(),
        status: nextStatus,
      });
    },
    []
  );

  /**
   * 사장님이 손님을 강제 퇴장 처리.
   * 미결제 주문은 cancelled 로 정리 (집계 보호) 후 테이블 정리.
   */
  const evictTable = useCallback(
    async (tableNumber: number, storeId: string) => {
      const tableId = `${storeId}_${tableNumber}`;
      const unpaid = ordersRef.current.filter(
        (o) => o.storeId === storeId && o.tableNumber === tableNumber && o.paymentStatus !== "paid"
      );
      // 미결제 주문 cancel — batch 로 묶어 all-or-nothing 보장.
      // 기존엔 개별 try/catch 로 부분 실패해도 진행 → 유령 pending 주문이
      // 매출 집계/재고 카운트에 영구히 남던 무결성 버그.
      if (unpaid.length > 0) {
        await saveDocs([
          ...unpaid.map((o) => ({ table: "orders", id: o.id, patch: { status: "cancelled" } })),
          {
            table: "tables",
            id: tableId,
            patch: {
              currentCustomerId: null,
              occupantIds: [],
              currentCustomerName: null,
              partySize: null,
              sessionStartTime: null,
              status: "dirty",
            },
          },
        ]);
        // 취소된 미결제 주문의 재고 복구(+1) — placeOrder 에서 차감했으므로 반대로. 이미 취소된 건 제외(중복 방지).
        const toRestore = unpaid.filter((o) => o.status !== "cancelled");
        if (toRestore.length > 0) {
          adjustStockForOrder(toRestore.flatMap((o) => o.items), +1).catch((e) => console.warn("[evictTable] stock restore failed", e?.message));
        }
      } else {
        await saveDoc("tables", tableId, {
          currentCustomerId: null,
          occupantIds: [],
          currentCustomerName: null,
          partySize: null,
          sessionStartTime: null,
          status: "dirty",
        });
      }
      showToast(t("store.tableEvicted", undefined, { n: tableNumber }), "success");
    },
    []
  );


  // ============ TABLES ============
  const addTable = useCallback(
    async (storeId: string, type: TableDoc["type"] = "table", sectionId?: string) => {
      const storeTables = tables.filter((t) => t.storeId === storeId);
      const nextNumber = storeTables.reduce((mx, t) => Math.max(mx, t.number), 0) + 1;
      const isRoom = type === "room";
      const t: TableDoc = {
        id: `${storeId}_${nextNumber}`,
        number: nextNumber,
        storeId,
        type,
        x: 40,
        y: 40,
        width: isRoom ? 150 : 70,
        height: isRoom ? 80 : 70,
        seats: isRoom ? 6 : 4,
        shape: "square",
        status: "available",
        sectionId,
      };
      await saveDoc("tables", t.id, t);
    },
    [tables]
  );

  const updateTableLayout = useCallback(
    async (storeId: string, number: number, data: Partial<TableDoc>) => {
      await saveDoc("tables", `${storeId}_${number}`, data);
    },
    []
  );

  const deleteTable = useCallback(async (storeId: string, number: number) => {
    await removeDoc("tables", `${storeId}_${number}`);
  }, []);

  const updateTableStatus = useCallback(
    async (storeId: string, number: number, status: TableStatus) => {
      const patch: Partial<TableDoc> = { status };
      // 비어있음으로 복귀 시 점유 정보 일괄 정리
      if (status === "available") {
        patch.currentCustomerId = null;
        patch.currentCustomerName = null;
        patch.occupantIds = [];
        patch.partySize = null;
        patch.sessionStartTime = null;
      }
      await saveDoc("tables", `${storeId}_${number}`, patch);
    },
    []
  );

  const initTables = useCallback(async (storeId: string) => {
    // 지우기와 새로 만들기가 한 트랜잭션이다. 갈라지면 테이블이 없는 매장이 남는다.
    await saveDocs([
      ...tables.filter((t) => t.storeId === storeId).map((t) => ({ table: "tables", id: t.id, remove: true })),
      ...makeDefaultTables(storeId).map((t) => ({ table: "tables", id: t.id, patch: t })),
    ]);
    showToast(t("store.tables.reset"), "success");
  }, [tables]);

  // ============ SECTIONS ============
  const addSection = useCallback(async (storeId: string, name: string) => {
    const id = newId();
    const order = sections.filter((s) => s.storeId === storeId).length;
    await saveDoc("sections", id, { id, storeId, name, order });
  }, [sections]);

  const updateSection = useCallback(async (id: string, data: Partial<Section>) => {
    await saveDoc("sections", id, data);
  }, []);

  const deleteSection = useCallback(async (id: string) => {
    await removeDoc("sections", id);
    // unassign tables in that section
    const targets = tables.filter((t) => t.sectionId === id);
    for (const t of targets) {
      await saveDoc("tables", t.id, { sectionId: null });
    }
  }, [tables]);


  /**
   * 사장님 '계산 완료' — 테이블을 비어있음(available) 으로 정리.
   * occupant 정리 + status: available + sessionStartTime 초기화.
   * approvePayment 가 status: paid 로 둔 테이블에 대해 호출.
   */
  const completeTable = useCallback(async (storeId: string, tableNumber: number) => {
    const tableId = `${storeId}_${tableNumber}`;
    await saveDoc("tables", tableId, {
      status: "available",
      currentCustomerId: null,
      currentCustomerName: null,
      occupantIds: [],
      partySize: null,
      sessionStartTime: null,
    });
    showToast(t("store.table.empty", undefined, { n: tableNumber }), "success");
  }, []);

  return { leaveTable, enterTable, evictTable, addTable, updateTableLayout, deleteTable, updateTableStatus, initTables, addSection, updateSection, deleteSection, completeTable };
}

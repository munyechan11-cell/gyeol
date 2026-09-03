import { newId, saveDoc, saveDocs } from "../../lib/db";
import type { StoreCore } from "../core";
import type { AdjustStock } from "./inventory";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t, fmtKRW, getLanguage } from "../../lib/i18n";
import { relayOrderToPos } from "../../lib/pos";
import { printReceipt } from "../../lib/receipt";
import { printReceiptViaUsb, getAuthorizedPrinters } from "../../lib/thermalPrinter";
import { enqueuePrintJob } from "../../lib/printBridge";
import { sendOwnerPush } from "../../lib/pushTriggers";
import { api } from "../../lib/api";
import { getStoreOpenStatus } from "../../lib/businessHours";
import type { Order, OrderItem, OrderStatus } from "../../lib/types";

export function useOrderActions(core: StoreCore, deps: { adjustStockForOrder: AdjustStock }) {
  const {
    currentUser, users, tables, menus, orders, ingredients, usersRef, tablesRef, ordersRef,
    approvingPaymentRef, lang,
  } = core;
  const { adjustStockForOrder } = deps;


  // ============ ORDERS ============
  const placeOrder = useCallback(
    async ({
      storeId,
      tableNumber,
      customerId,
      items,
      manual,
    }: {
      storeId: string;
      tableNumber: number;
      customerId: string;
      items: OrderItem[];
      manual?: boolean;
    }): Promise<Order> => {
      // 영업 시간 검증 — 영업 외 시간이거나 임시 마감이면 손님 셀프 주문(키오스크 포함) 차단.
      // 단 사장/직원이 카운터에서 직접 입력하는 수동 주문(manual)은 영업 준비·마감 정리 중에도
      // 받을 수 있어야 하므로 검증을 건너뛴다 (실매장 POS 동작과 일치).
      if (!manual) {
        const ownerForCheck = usersRef.current.find((u) => u.id === storeId && u.role === "owner");
        const status = getStoreOpenStatus(ownerForCheck);
        if (status.open === false) {
          const msg = status.reason;
          showToast(t("store.order.cannot", undefined, { msg }), "error");
          throw new Error(msg);
        }
      }

      // 항목 입력 검증 — 음수·0 가격, 음수·0 수량 차단 (조작·실수 방어)
      if (!Array.isArray(items) || items.length === 0) {
        showToast(t("store.order.empty"), "error");
        throw new Error("empty items");
      }
      for (const it of items) {
        if (typeof it.price !== "number" || !Number.isFinite(it.price) || it.price <= 0) {
          showToast(t("store.order.invalidAmount"), "error");
          throw new Error("invalid price");
        }
        if (typeof it.quantity !== "number" || !Number.isFinite(it.quantity) || it.quantity <= 0 || it.quantity > 99) {
          showToast(t("store.order.invalidQty"), "error");
          throw new Error("invalid quantity");
        }
      }

      // 강제 퇴장 race 방어 — 사장님이 직전에 evictTable 했으면 손님은 그 테이블에 없음
      const tableId = `${storeId}_${tableNumber}`;
      const tableNow = tablesRef.current.find((t) => t.id === tableId);
      const isCustomer = currentUser?.role === "customer";
      if (isCustomer && tableNow && tableNow.currentCustomerId && tableNow.currentCustomerId !== customerId &&
          !(tableNow.occupantIds ?? []).includes(customerId)) {
        showToast(t("store.order.tableCleared"), "error");
        throw new Error("table not occupied by this customer");
      }

      const totalAmount = items.reduce((s, it) => s + it.price * it.quantity, 0);
      const order: Order = {
        id: newId(),
        storeId,
        tableNumber,
        customerId,
        items,
        totalAmount,
        status: "pending",
        paymentStatus: "unpaid",
        createdAt: new Date().toISOString(),
      };
      await saveDoc("orders", order.id, order);

      // 8단계 자동 전이 — 주문이 발생하면 테이블 상태 dining 으로 (occupied/setup/available 일 때만)
      try {
        const tableId = `${storeId}_${tableNumber}`;
        const cur = tablesRef.current.find((t) => t.id === tableId);
        const curStatus = cur?.status;
        if (curStatus === "occupied" || curStatus === "setup" || curStatus === "available" || !curStatus) {
          await saveDoc("tables", tableId, { status: "dining" });
        }
      } catch (e: any) {
        console.warn("[placeOrder] status→dining skip", e?.message);
      }

      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const hasPosApi =
        owner?.posVendor && owner.posVendor !== "none" && owner.posApiKey;

      // 사장님 디바이스 푸시 — 새 주문 도착
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId,
        kind: "new-order",
        title: t("gnotif.newOrder.title", ownerLang, { table: tableNumber }),
        body: t("gnotif.newOrder.body", ownerLang, { count: items.length, amount: fmtKRW(totalAmount, ownerLang) }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-order-T${tableNumber}`,
      });

      // ⚠️ 주문 시점에는 영수증 인쇄하지 않음 (정책 변경 — 2026-06).
      //   영수증은 결제 승인 시점에 '총 영수증' 한 번만 출력.
      //   POS API 연동만 즉시 호출 (주방 전달 등 매장 운영에 필요).
      if (hasPosApi || owner?.foodtechStoreCode) {
        const apiKey = owner?.posApiKey || owner?.foodtechStoreCode || "";
        const ok = await relayOrderToPos(
          apiKey,
          order,
          (mid) => menus.find((m) => m.id === mid)?.posProductCode,
          owner?.posVendor
        );
        if (!ok) {
          console.warn("[POS relay] failed — manual handling needed");
        }
      }
      // 영수증 인쇄(①②③④) 는 모두 결제 승인 시점(approvePayment) 으로 이동.
      // 손님이 중간에 영수증을 원하면 BillModal 의 '계산서 보기' 로 확인 가능.

      // 재고 자동 차감 — 메뉴.recipe 가 등록된 경우만. 실패해도 주문 자체는 진행.
      adjustStockForOrder(items, -1).catch((e) => {
        console.warn("[ingredients] adjust failed", e);
      });

      showToast(t("store.order.placed"), "success");
      return order;
    },
    [users, menus]
  );

  const updateOrderStatus = useCallback(async (id: string, status: OrderStatus) => {
    // 취소로 전환 시 주문 시점에 차감한 재고 복구(+1). 이미 취소된 주문은 중복 복구 방지.
    if (status === "cancelled") {
      const order = ordersRef.current.find((o) => o.id === id);
      if (order && order.status !== "cancelled") {
        adjustStockForOrder(order.items, +1).catch((e) => console.warn("[cancel] stock restore failed", e?.message));
      }
    }
    await saveDoc("orders", id, { status });
  }, []);

  /**
   * 손님이 '결제하기' — 결제 요청만 보냄. 실제 결제·영수증은 사장님 승인 시점에.
   * 미결제 주문들의 paymentStatus 를 'requested' 로 변경 + 테이블 표시는 유지.
   */
  const payTableSession = useCallback(
    async (customerId: string, storeId: string, tableNumber: number): Promise<number> => {
      const ordersNow = ordersRef.current;
      const unpaid = ordersNow.filter(
        (o) =>
          o.customerId === customerId &&
          o.storeId === storeId &&
          o.tableNumber === tableNumber && // 현재 테이블 주문만 — 다른 테이블 주문까지 결제되던 버그 방지
          o.status !== "cancelled" &&
          o.paymentStatus !== "paid"
      );
      if (unpaid.length === 0) {
        showToast(t("store.pay.noUnpaid"), "info");
        return 0;
      }
      const total = unpaid.reduce((s, o) => s + o.totalAmount, 0);

      await saveDocs(
        unpaid.map((o) => ({ table: "orders", id: o.id, patch: { paymentStatus: "requested" } }))
      );

      // 사장님 디바이스 푸시 — 결제 요청
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId,
        kind: "payment-request",
        title: t("gnotif.payment.title", ownerLang, { table: tableNumber }),
        body: t("gnotif.payment.body", ownerLang, { amount: fmtKRW(total, ownerLang), count: unpaid.length }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-pay-T${tableNumber}`,
      });

      showToast(t("store.pay.requested", undefined, { amount: `₩ ${total.toLocaleString()}` }), "info");
      return total;
    },
    []
  );

  /**
   * 카드결제 성공 콜백 — 토스 successUrl(/pay/success)에서 호출.
   * 서버 confirm 으로 실제 결제를 확정한 뒤, 그 손님의 미결제 주문을 paid 로 전환하고
   * 사장님에게 '결제 완료' 푸시를 보낸다. (영수증 인쇄는 사장님 측 approvePayment 와 분리)
   */
  const confirmTossPayment = useCallback(
    async (params: {
      storeId: string;
      customerId: string;
      tableNumber: number;
      paymentKey: string;
      orderId: string;
      amount: number;
      orderIds: string[];
    }): Promise<void> => {
      // 1) 서버에서 토스 결제 승인 (실제 과금 확정)
      const res = await fetch(api("/api/payment/confirm"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentKey: params.paymentKey,
          orderId: params.orderId,
          amount: params.amount,
          storeId: params.storeId, // 매장별 시크릿 키로 confirm (멀티테넌트 정산)
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err?.error ?? "payment-confirm-failed");
      }

      // 2) 결제 시작 시점에 스냅샷한 주문만 paid 로 전환 (왕복 중 추가된 주문은 제외 — 과다 결제완료 방지)
      const targets = ordersRef.current.filter(
        (o) => params.orderIds.includes(o.id) && o.paymentStatus !== "paid"
      );
      if (targets.length > 0) {
        // 현금 승인(approvePayment)과 동일하게 테이블도 'paid'(정리 대기)로 — 카드결제 후에도 사장님 테이블맵에 정리 신호가 뜨도록.
        const tableId = `${params.storeId}_${params.tableNumber}`;
        await saveDocs([
          ...targets.map((o) => ({
            table: "orders",
            id: o.id,
            patch: { paymentStatus: "paid", paymentMethod: "card" },
          })),
          ...(tablesRef.current.some((t) => t.id === tableId)
            ? [{ table: "tables", id: tableId, patch: { status: "paid" } }]
            : []),
        ]);
      }

      // 3) 사장님 디바이스로 '결제 완료' 푸시 (영수증 인쇄는 사장님 화면에서)
      const ownerLang = usersRef.current.find((u) => u.id === params.storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId: params.storeId,
        kind: "payment-request",
        title: t("gnotif.paid.title", ownerLang, { table: params.tableNumber }),
        body: t("gnotif.paid.body", ownerLang, { amount: fmtKRW(params.amount, ownerLang) }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-paid-T${params.tableNumber}`,
      });
    },
    []
  );

  /**
   * 사장님이 '결제 승인' — 실제 결제 처리 + 총 영수증 인쇄.
   * - paymentStatus: requested|unpaid → paid
   * - 테이블 status: occupied → paid (정리 대기)
   * - 영수증 인쇄 ①POS → ②USB → ③팝업 → ④브릿지 큐 모두 시도
   *
   * 멱등성·중복 방지:
   *  - 같은 (storeId,tableNumber) 처리 중이면 즉시 0 반환 (2디바이스 동시 승인 차단)
   *  - 사장님 폰 + PC 동시 클릭 시에도 영수증 2장 출력 방지
   *  - Firestore 룰이 최종 방어선이지만 클라이언트 mutex 로 1차 차단
   */
  const approvePayment = useCallback(
    async (storeId: string, tableNumber: number): Promise<number> => {
      const lockKey = `${storeId}_${tableNumber}`;
      if (approvingPaymentRef.current.has(lockKey)) {
        showToast(t("store.pay.alreadyApproving"), "info");
        return 0;
      }
      approvingPaymentRef.current.add(lockKey);
      // 락은 try/finally 로 해제 — 기존 setTimeout(1500ms) 는 USB 프린터/네트워크가
      // 더 느릴 때 두 번째 클릭이 통과해 영수증 2장 출력되던 버그가 있었음.
      try {
        const ordersNow = ordersRef.current;
        const tablesNow = tablesRef.current;
        const targets = ordersNow.filter(
          (o) =>
            o.storeId === storeId &&
            o.tableNumber === tableNumber &&
            o.status !== "cancelled" &&
            o.paymentStatus !== "paid"
        );
        if (targets.length === 0) {
          showToast(t("store.pay.noRequest"), "info");
          return 0;
        }
        const total = targets.reduce((s, o) => s + o.totalAmount, 0);

        // 1) 일괄 업데이트: 주문 paid + 테이블 status: paid (한 트랜잭션)
        const tableId = `${storeId}_${tableNumber}`;
        await saveDocs([
          ...targets.map((o) => ({
            table: "orders",
            id: o.id,
            patch: { paymentStatus: "paid", paymentMethod: "cash" },
          })),
          ...(tablesNow.some((t) => t.id === tableId)
            ? [{ table: "tables", id: tableId, patch: { status: "paid" } }]
            : []),
        ]);

        // 2) 총 영수증 1장 — 모든 주문 항목 합쳐서
        const owner = users.find((u) => u.id === storeId && u.role === "owner");
        const aggregated: Order = {
          id: `RECEIPT_${storeId}_${tableNumber}_${Date.now()}`,
          storeId,
          tableNumber,
          customerId: targets[0].customerId,
          items: targets.flatMap((o) => o.items),
          totalAmount: total,
          status: "served",
          paymentStatus: "paid",
          createdAt: new Date().toISOString(),
        };
        const payload = {
          storeName: owner?.restaurantName ?? "결",
          order: aggregated,
          footer: t("receipt.footer.aggregated", getLanguage(), { table: tableNumber, count: targets.length }),
        };

        // 브릿지 큐 우선 (매장 PC 에이전트가 처리)
        let printedSomewhere = false;
        if (owner?.printBridgeEnabled) {
          try {
            await enqueuePrintJob({
              storeId, type: "receipt", payload, expectedUid: storeId,
            });
            printedSomewhere = true;
          } catch (e) {
            console.warn("[approvePayment] bridge enqueue failed", e);
          }
        }
        // USB → 팝업 폴백 (사장님 화면에서 호출되는 경우만)
        try {
          const printers = await getAuthorizedPrinters();
          if (printers.length > 0) {
            await printReceiptViaUsb(payload);
            printedSomewhere = true;
          } else {
            printReceipt(payload);
            printedSomewhere = true;
          }
        } catch (e: any) {
          try {
            printReceipt(payload);
            printedSomewhere = true;
          } catch {
            // 팝업도 차단됨 — 브릿지 큐도 실패했다면 출력 0장
          }
        }

        // 영수증 인쇄 실패 시 사장님에게 명시. 결제는 완료된 상태이므로
        // success 가 아닌 warning(info) 으로 — 다시 인쇄 안내.
        if (printedSomewhere) {
          showToast(t("store.pay.approved", undefined, { amount: `₩ ${total.toLocaleString()}` }), "success");
        } else {
          showToast(t("store.pay.printFailed", undefined, { amount: `₩ ${total.toLocaleString()}` }), "info");
        }
        return total;
      } finally {
        approvingPaymentRef.current.delete(lockKey);
      }
    },
    [users]
  );


  /** 선택 인쇄 — 사장님 또는 손님이 원할 때 즉시 영수증(합산 미리보기) 출력 */
  const printInterimReceipt = useCallback(
    async (storeId: string, tableNumber: number) => {
      const ordersNow = ordersRef.current;
      const open = ordersNow.filter(
        (o) =>
          o.storeId === storeId &&
          o.tableNumber === tableNumber &&
          o.status !== "cancelled"
      );
      if (open.length === 0) {
        showToast(t("store.receipt.noOrder"), "info");
        return;
      }
      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const total = open.reduce((s, o) => s + o.totalAmount, 0);
      const aggregated: Order = {
        id: `INTERIM_${storeId}_${tableNumber}_${Date.now()}`,
        storeId, tableNumber,
        customerId: open[0].customerId,
        items: open.flatMap((o) => o.items),
        totalAmount: total,
        status: "served",
        paymentStatus: "unpaid",
        createdAt: new Date().toISOString(),
      };
      const payload = {
        storeName: owner?.restaurantName ?? "결",
        order: aggregated,
        footer: t("receipt.footer.interim", getLanguage()),
      };
      if (owner?.printBridgeEnabled) {
        void enqueuePrintJob({ storeId, type: "receipt", payload, expectedUid: storeId });
      }
      try {
        const printers = await getAuthorizedPrinters();
        if (printers.length > 0) await printReceiptViaUsb(payload);
        else printReceipt(payload);
      } catch {
        try { printReceipt(payload); } catch { /* ignore */ }
      }
      showToast(t("store.receipt.interim"), "info");
    },
    [users]
  );


  // 대기 탭의 미결제 주문을 실제 테이블로 이동 (구두주문 후 손님이 자리 잡으면)
  const moveOrdersTable = useCallback(
    async (storeId: string, fromTable: number, toTable: number) => {
      const targets = ordersRef.current.filter(
        (o) =>
          o.storeId === storeId &&
          o.tableNumber === fromTable &&
          o.status !== "cancelled" &&
          o.paymentStatus !== "paid"
      );
      for (const o of targets) {
        await saveDoc("orders", o.id, { tableNumber: toTable });
      }
    },
    []
  );

  return { placeOrder, updateOrderStatus, payTableSession, confirmTossPayment, approvePayment, printInterimReceipt, moveOrdersTable };
}

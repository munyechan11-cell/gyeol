import { newId, saveDoc } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import { sendOwnerPush } from "../../lib/pushTriggers";
import type { Coupon, Order } from "../../lib/types";

export function useCouponActions(core: StoreCore) {
  const { coupons, orders, usersRef, couponsRef, ordersRef, lang } = core;


  // ============ COUPONS ============
  const issueCoupon = useCallback(
    async (customerId: string, storeId: string, type: string, description: string, amount?: number, opts?: { silent?: boolean; descKey?: string }) => {
      const amt = Math.max(0, Math.round(Number(amount) || 0));
      const c: Coupon = {
        id: newId(),
        customerId,
        storeId,
        type,
        description,
        ...(amt > 0 ? { amount: amt } : {}), // 금액 쿠폰(8-7)
        ...(opts?.descKey ? { descKey: opts.descKey } : {}), // i18n 키 — 손님 언어로 번역 표시(#8/#20)
        status: "available",
        issuedAt: new Date().toISOString(),
      };
      await saveDoc("coupons", c.id, c);
      // 자동 보상(손님 기기)에선 발급자 시점 토스트 억제 — 도착 알림(coupons.arrived)으로 일원화
      if (!opts?.silent) showToast(t("store.coupon.issued"), "success");
    },
    []
  );

  const requestCouponUse = useCallback(async (couponId: string, tableNumber?: number) => {
    await saveDoc("coupons", couponId, {
      status: "pending",
      usedAtTable: tableNumber ?? null,
    });
    // 쿠폰의 매장(storeId) 으로 사장님 푸시
    const c = couponsRef.current.find((x) => x.id === couponId);
    if (c?.storeId) {
      const ownerLang = usersRef.current.find((u) => u.id === c.storeId)?.lang ?? "ko";
      const couponDesc = c.description ?? t("gnotif.coupon.descFallback", ownerLang);
      sendOwnerPush({
        storeId: c.storeId,
        kind: "coupon-request",
        title: t("gnotif.coupon.title", ownerLang),
        body: tableNumber
          ? t("gnotif.coupon.bodyTable", ownerLang, { desc: couponDesc, table: tableNumber })
          : t("gnotif.coupon.body", ownerLang, { desc: couponDesc }),
        focusUrl: "/biz/owner/orders",
        tag: "gyeol-coupon",
      });
    }
    showToast(t("store.coupon.requested"), "info");
  }, []);

  const cancelCouponRequest = useCallback(async (couponId: string) => {
    await saveDoc("coupons", couponId, {
      status: "available",
      usedAtTable: null,
    });
    showToast(t("store.coupon.requestCancelled"), "info");
  }, []);

  const approveCouponUse = useCallback(async (couponId: string) => {
    const c = couponsRef.current.find((x) => x.id === couponId);
    // 8-7: 금액 쿠폰이면 그 테이블 계산서에 할인 라인(−금액)을 추가 → approvePayment 합산 시 자동 차감.
    // status !== 'used' 가드 — 이미 사용된 쿠폰 재승인 시 할인 중복 생성 방지.
    if (c && c.status !== "used" && (c.amount ?? 0) > 0 && c.usedAtTable != null) {
      const billTotal = ordersRef.current
        .filter((o) => o.storeId === c.storeId && o.tableNumber === c.usedAtTable && o.status !== "cancelled" && o.paymentStatus !== "paid")
        .reduce((s, o) => s + o.totalAmount, 0);
      const discount = Math.min(c.amount!, Math.max(0, billTotal)); // 계산서 초과 차감 방지
      if (discount <= 0) {
        showToast(t("store.coupon.noBill"), "error"); // 차감할 미결제 금액이 없음
        return;
      }
      const discountOrder: Order = {
        // 쿠폰 기반 결정적 id — 더블클릭·다중 디바이스 동시 승인 시 같은 문서를 덮어써(merge) 할인 라인 중복 생성 원천 차단
        id: `COUPONDISC_${couponId}`,
        storeId: c.storeId,
        tableNumber: c.usedAtTable,
        customerId: c.customerId,
        items: [{ menuId: "", name: t("store.coupon.discountLine"), quantity: 1, price: -discount }],
        totalAmount: -discount,
        status: "served", // 주방·활성주문 흐름에서 제외
        paymentStatus: "unpaid", // 테이블 결제 시 함께 paid 처리
        createdAt: new Date().toISOString(),
      };
      await saveDoc("orders", discountOrder.id, discountOrder);
    }
    await saveDoc("coupons", couponId, {
      status: "used",
      usedAt: new Date().toISOString(),
    });
    showToast(t("store.coupon.approved"), "success");
  }, []);

  const rejectCouponUse = useCallback(async (couponId: string) => {
    await saveDoc("coupons", couponId, {
      status: "available",
      usedAtTable: null,
    });
    showToast(t("store.coupon.rejected"), "info");
  }, []);

  return { issueCoupon, requestCouponUse, cancelCouponRequest, approveCouponUse, rejectCouponUse };
}

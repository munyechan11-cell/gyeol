import { newId, removeDoc, saveDoc, saveDocs } from "../../lib/db";
import { recordVisitRpc } from "../../lib/rpc";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import type { Communication, Tier } from "../../lib/types";

export function useCustomerActions(core: StoreCore) {
  const { couponsRef, currentUserRef, setCurrentUser } = core;


  // ============ VISITS ============
  /**
   * 손님 QR 진입 — 방문(하루 1회)·적립·등급 쿠폰·테이블 점유.
   *
   * 예전엔 손님 기기가 이 넷을 각각 썼다. RLS 를 걸면서 손님이 자기 쿠폰·적립금을
   * 직접 쓰지 못하게 했으므로(쓸 수 있으면 마음대로 만든다), 규칙을 아는 DB 함수가
   * 대신 쓴다. 사장님 설정(적립 방식·등급 보상)은 함수가 읽는다.
   */
  const recordVisit = useCallback(
    async (customerId: string, tableNumber: number, storeId: string, amount?: number) => {
      // 10초 디바운스
      const guardKey = `gyeol:last_visit_${customerId}_${storeId}`;
      const last = Number(sessionStorage.getItem(guardKey) || 0);
      if (Date.now() - last < 10_000) return;
      sessionStorage.setItem(guardKey, String(Date.now()));

      const r = await recordVisitRpc(storeId, tableNumber, amount);

      // 로컬 currentUser 도 즉시 반영 (UI stale 방지) — 실제 값은 users 구독이 곧 덮어쓴다.
      const currentUser = currentUserRef.current;
      if (r.rewardDelta > 0 && currentUser?.id === customerId) {
        setCurrentUser({
          ...currentUser,
          rewardBalance: (currentUser.rewardBalance ?? 0) + r.rewardDelta,
        });
      }
      if (r.newVisit) showToast(t("store.visitRecorded"), "success");
    },
    [setCurrentUser]
  );


  // ============ CRM ============
  const recordCommunication = useCallback(
    async (
      customerId: string,
      storeId: string,
      type: "coupon" | "message",
      content: string,
      senderRole: "owner" | "customer" = "owner"
    ) => {
      const c: Communication = {
        id: newId(),
        customerId,
        storeId,
        type,
        senderRole,
        content,
        date: new Date().toISOString(),
      };
      await saveDoc("Communications", c.id, c);
    },
    []
  );

  const updateUserMemo = useCallback(async (userId: string, memo: string) => {
    await saveDoc("users", userId, { memo });
  }, []);


  const setCustomerTier = useCallback(
    async (customerId: string, storeId: string, tier: Tier | "auto") => {
      const id = `${customerId}_${storeId}`;
      if (tier === "auto") {
        await removeDoc("tierOverrides", id);
      } else {
        await saveDoc("tierOverrides", id, { customerId, storeId, tier });
      }
    },
    []
  );

  const bulkIssueCoupon = useCallback(
    async (customerIds: string[], storeId: string, type: string, description: string, amount?: number, descKey?: string) => {
      const amt = Math.max(0, Math.round(Number(amount) || 0)); // 금액 쿠폰(8-7)
      // 이미 같은 종류의 미사용 쿠폰을 보유한 손님은 제외 — 재방문/연타 시 중복 발급 방지
      const existing = couponsRef.current;
      const targets = customerIds.filter(
        (cid) =>
          !existing.some(
            (c) =>
              c.customerId === cid &&
              c.storeId === storeId &&
              c.type === type &&
              c.status === "available"
          )
      );
      if (targets.length === 0) {
        showToast(t("store.bulkCouponNone"), "info");
        return;
      }
      const now = new Date().toISOString();
      // 한 번에 500건까지라 450개씩 나눠 보낸다. 덩어리끼리는 서로 독립이다 —
      // 대형 매장에서 뒤쪽이 실패해도 앞쪽 발급은 살아 있는 편이 낫다.
      for (let i = 0; i < targets.length; i += 450) {
        await saveDocs(
          targets.slice(i, i + 450).map((cid) => {
            const id = newId();
            return {
              table: "coupons",
              id,
              patch: {
                id,
                customerId: cid,
                storeId,
                type,
                description,
                ...(amt > 0 ? { amount: amt } : {}),
                ...(descKey ? { descKey } : {}), // i18n 키 — 손님 언어로 번역 표시(#8)
                status: "available",
                issuedAt: now,
              },
            };
          })
        );
      }
      showToast(t("store.bulkCoupon", undefined, { n: targets.length }), "success");
    },
    []
  );

  return { recordVisit, recordCommunication, updateUserMemo, setCustomerTier, bulkIssueCoupon };
}

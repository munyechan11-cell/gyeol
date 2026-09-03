import { increment, newId, removeDoc, saveDoc, saveDocs } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import type { Visit, Coupon, Communication, Tier } from "../../lib/types";

export function useCustomerActions(core: StoreCore) {
  const {
    currentUser, users, visits, coupons, tables, tierOverrides, usersRef, visitsRef, couponsRef,
    tablesRef, currentUserRef, setCurrentUser,
  } = core;


  // ============ VISITS ============
  const recordVisit = useCallback(
    async (customerId: string, tableNumber: number, storeId: string, amount?: number) => {
      // 10초 디바운스
      const guardKey = `gyeol:last_visit_${customerId}_${storeId}`;
      const last = Number(sessionStorage.getItem(guardKey) || 0);
      if (Date.now() - last < 10_000) return;
      sessionStorage.setItem(guardKey, String(Date.now()));

      // ref로 최신 스냅샷 읽어 identity 안정화
      const users = usersRef.current;
      const visits = visitsRef.current;
      const coupons = couponsRef.current;
      const tables = tablesRef.current;
      const currentUser = currentUserRef.current;

      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const today = new Date().toDateString();
      const alreadyToday = visits.some(
        (v) =>
          v.customerId === customerId &&
          v.storeId === storeId &&
          new Date(v.date).toDateString() === today
      );

      // 1) Create visit (only once per day)
      if (!alreadyToday) {
        const visit: Visit = {
          id: newId(),
          customerId,
          storeId,
          tableNumber,
          date: new Date().toISOString(),
          totalAmount: amount,
        };
        await saveDoc("visits", visit.id, visit);

        // Reward accrual (Firestore increment으로 atomic 처리)
        if (owner?.storeConfig) {
          const cfg = owner.storeConfig;
          let delta = 0;
          if (cfg.rewardType === "stamp") {
            delta = 1;
          } else if (cfg.rewardType === "point") {
            const rate = cfg.pointRate ?? 0.05;
            const base = amount ?? 10000;
            delta = Math.floor(base * rate);
          }
          if (delta > 0) {
            await saveDoc("users", customerId, {
              rewardBalance: increment(delta),
            });
            // 로컬 currentUser도 즉시 반영 (UI stale 방지)
            if (currentUser?.id === customerId) {
              setCurrentUser({
                ...currentUser,
                rewardBalance: (currentUser.rewardBalance ?? 0) + delta,
              });
            }
          }
        }

        // 2) Tier coupons
        const myVisits = [
          ...visits.filter((v) => v.customerId === customerId && v.storeId === storeId),
          visit,
        ];
        const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
        const uniqueDays = new Set(
          myVisits
            .filter((v) => new Date(v.date).getTime() >= thirtyDaysAgo)
            .map((v) => new Date(v.date).toDateString())
        ).size;

        const tierRules: { min: number; tier: Tier; descKey: string }[] = [
          { min: 12, tier: "VIP", descKey: "coupon.reward.vip" },
          { min: 8, tier: "다이아", descKey: "coupon.reward.diamond" },
          { min: 6, tier: "골드", descKey: "coupon.reward.gold" },
          { min: 4, tier: "실버", descKey: "coupon.reward.silver" },
          { min: 2, tier: "브론즈", descKey: "coupon.reward.bronze" },
        ];
        for (const rule of tierRules) {
          if (uniqueDays >= rule.min) {
            const already = coupons.some(
              (c) => c.customerId === customerId && c.storeId === storeId && c.type === rule.tier
            );
            if (!already) {
              // 사장님이 보상을 커스텀했으면 그 문자열(사장님 언어 그대로), 아니면 descKey 를 저장해
              // 표시 시점에 t(descKey, 고객언어) 로 변환 → 비한국어 고객도 모국어로 쿠폰을 봄.
              const custom = owner?.tierRewards?.[rule.tier];
              const c: Coupon = {
                id: newId(),
                customerId,
                storeId,
                type: rule.tier,
                description: custom ?? t(rule.descKey, "ko"),
                ...(custom ? {} : { descKey: rule.descKey }),
                status: "available",
                issuedAt: new Date().toISOString(),
              };
              await saveDoc("coupons", c.id, c);
            }
            break;
          }
        }
      }

      // 3) Table state — 사장이 인쇄한 QR이면 정식 테이블로 자동 생성
      const tableId = `${storeId}_${tableNumber}`;
      const existing = tables.find((t) => t.id === tableId);
      if (existing) {
        await saveDoc("tables", tableId, {
          currentCustomerId: customerId,
          sessionStartTime: new Date().toISOString(),
          status: "occupied",
        });
      } else {
        // 없는 번호로 들어오면 새 테이블 doc 생성 (없으면 myTable이 영원히 안 잡혀 손님이 "테이블 이용" 메시지를 계속 봄)
        const num = Number(tableNumber);
        const col = ((num - 1) % 5 + 5) % 5;
        const row = Math.max(0, Math.floor((num - 1) / 5));
        await saveDoc("tables", tableId, {
          id: tableId,
          number: num,
          storeId,
          type: "table",
          shape: "square",
          seats: 4,
          width: 90,
          height: 90,
          x: col * 120 + 40,
          y: row * 120 + 40,
          status: "occupied",
          currentCustomerId: customerId,
          sessionStartTime: new Date().toISOString(),
        });
      }

      if (!alreadyToday) showToast(t("store.visitRecorded"), "success");
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

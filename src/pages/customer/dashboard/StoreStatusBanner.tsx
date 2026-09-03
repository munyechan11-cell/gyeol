import { useEffect, useState } from "react";
import { useLanguage, t } from "../../../lib/i18n";
import { Card } from "../../../components/ui/Card";
import { getStoreOpenStatus, summarizeStatus } from "../../../lib/businessHours";

// ============================================================
export function StoreStatusBanner({ owner }: { owner: any }) {
  const lang = useLanguage();
  const [status, setStatus] = useState(() => getStoreOpenStatus(owner));
  useEffect(() => {
    setStatus(getStoreOpenStatus(owner));
    const id = setInterval(() => setStatus(getStoreOpenStatus(owner)), 60_000);
    return () => clearInterval(id);
  }, [owner?.temporarilyClosed, owner?.businessHours]);

  if (status.open) {
    // 영업 중 — 작은 칩 (시각 차이로 안심 신호)
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-mint-50)] text-[var(--color-mint-700)] text-[11.5px] font-bold">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-mint-500)] animate-pulse" />
        {summarizeStatus(status)}
      </div>
    );
  }

  // 영업 외 — 큰 카드로 강조 (TypeScript narrowing 보장)
  const closed = status; // narrowing 확정: open === false
  return (
    <Card padding="md" className="border-2 border-[var(--color-danger)] bg-[#fef2f2]">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[var(--color-danger)] text-white inline-flex items-center justify-center font-extrabold text-[16px]">
          ⛔
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-extrabold text-[var(--color-danger)]">
            {t("store.closedTitle", lang)}
          </p>
          <p className="text-[12.5px] text-[var(--color-ink-700)] mt-0.5 font-semibold leading-relaxed">
            {closed.open === false ? closed.reason : ""}
            {closed.open === false && closed.from ? t("store.closedFrom", lang, { time: closed.from }) : ""}
          </p>
          <p className="text-[11px] text-[var(--color-ink-500)] mt-1 font-medium">
            {t("store.closedDesc", lang)}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// 지난 방문 영수증 — 같은 매장 재방문 시 과거 결제 완료된 주문을 명확히 분리

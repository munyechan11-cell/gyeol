import { Hourglass, ClipboardCheck, ChefHat, PartyPopper } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import { cn } from "../../../lib/cn";
import type { Industry } from "../../../lib/types";
import { cookingNowLabel } from "../../../lib/cookingLabels";


export function OrderProgress({ status, industry }: { status: "pending" | "accepted" | "cooking" | "served"; industry?: Industry }) {
  const lang = useLanguage();
  const steps = [
    { key: "pending", label: t("order.status.pending", lang), Icon: Hourglass, eta: 5 },
    { key: "accepted", label: t("order.status.accepted", lang), Icon: ClipboardCheck, eta: 5 },
    { key: "cooking", label: cookingNowLabel(industry, lang), Icon: ChefHat, eta: 10 }, // 8-9: 업종별
    { key: "served", label: t("order.status.served", lang), Icon: PartyPopper, eta: 0 },
  ] as const;
  const currentIdx = Math.max(0, steps.findIndex((s) => s.key === status));
  const current = steps[currentIdx];
  const CurrentIcon = current.Icon;
  const done = status === "served";
  // 남은 예상 시간 — 현재 단계 이후 단계들의 eta 합
  const remainEta = steps.slice(currentIdx).reduce((s, st) => s + st.eta, 0);

  return (
    <div className="mb-3">
      {/* 현재 단계 — 큰 히어로 카드 (배민 스타일) */}
      <div
        className={cn(
          "flex items-center gap-3 p-3.5 rounded-[16px] mb-3 border",
          done
            ? "bg-[var(--color-mint-50)] border-[var(--color-mint-200)]"
            : "bg-[var(--color-navy-50)] border-[var(--color-navy-200)]"
        )}
      >
        <div
          className={cn(
            "w-12 h-12 rounded-full inline-flex items-center justify-center shrink-0 text-white",
            done ? "bg-[var(--color-mint-500)]" : "bg-[var(--color-navy-700)]",
            !done && "animate-bounce"
          )}
          style={!done ? { animationDuration: "1.6s" } : undefined}
        >
          <CurrentIcon className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={cn(
              "text-[15px] font-extrabold",
              done ? "text-[var(--color-mint-700)]" : "text-[var(--color-navy-900)]"
            )}
          >
            {t(`order.flow.headline.${current.key}`, lang)}
          </p>
          <p className="text-[12px] font-semibold text-[var(--color-ink-500)] mt-0.5">
            {done
              ? t("order.flow.thanks", lang)
              : t("order.flow.eta", lang, { min: remainEta })}
          </p>
        </div>
      </div>

      {/* 4단계 아이콘 트랙 */}
      <div className="flex items-center px-1">
        {steps.map((s, i) => {
          const reached = i <= currentIdx;
          const active = i === currentIdx && !done;
          const StepIcon = s.Icon;
          return (
            <div key={s.key} className="flex-1 flex items-center first:flex-none">
              {i > 0 && (
                <div
                  className={cn(
                    "h-[3px] flex-1 rounded-full mx-1 transition-colors duration-500",
                    reached ? "bg-[var(--color-mint-500)]" : "bg-[var(--color-ink-100)]"
                  )}
                />
              )}
              <div
                className={cn(
                  "w-9 h-9 rounded-full inline-flex items-center justify-center transition-colors shrink-0",
                  reached
                    ? "bg-[var(--color-mint-500)] text-white shadow-[0_2px_6px_rgba(0,163,158,0.35)]"
                    : "bg-[var(--color-ink-100)] text-[var(--color-ink-400)]",
                  active && "ring-4 ring-[var(--color-mint-500)]/25 animate-pulse"
                )}
              >
                <StepIcon className="w-[18px] h-[18px]" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5 px-0.5">
        {steps.map((s, i) => (
          <span
            key={s.key}
            className={cn(
              "text-[11px] font-bold tracking-tight",
              i === currentIdx
                ? "text-[var(--color-mint-700)]"
                : i < currentIdx
                ? "text-[var(--color-ink-600)]"
                : "text-[var(--color-ink-400)]"
            )}
          >
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function OrderStatusPill({ status }: { status: "pending" | "accepted" | "cooking" | "served" | "cancelled" }) {
  const lang = useLanguage();
  const map = {
    pending: { key: "order.status.pending", cls: "bg-[var(--color-navy-100)] text-[var(--color-navy-700)]" },
    accepted: { key: "order.status.accepted", cls: "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]" },
    cooking: { key: "order.status.cooking", cls: "bg-[#fff1e0] text-[#b45309]" },
    served: { key: "order.status.served", cls: "bg-[var(--color-ink-50)] text-[var(--color-ink-500)]" },
    cancelled: { key: "order.status.cancelled", cls: "bg-[#fef2f2] text-[var(--color-danger)]" },
  } as const;
  const s = map[status];
  return <span className={`px-2.5 py-1 rounded-full text-[12px] font-bold ${s.cls}`}>{t(s.key, lang)}</span>;
}

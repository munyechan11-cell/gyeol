import { useState } from "react";
import { Receipt as ReceiptIcon } from "lucide-react";
import { useLanguage, t, fmtKRW, getLocale } from "../../../lib/i18n";
import { Card } from "../../../components/ui/Card";
import { cn } from "../../../lib/cn";
import type { Order } from "../../../lib/types";

// ============================================================
type PastVisitGroup = {
  date: string;          // YYYY-MM-DD
  orders: Order[];
  total: number;
  itemsCount: number;
};
export function PastVisitsCard({ visits, storeName }: { visits: PastVisitGroup[]; storeName: string }) {
  const lang = useLanguage();
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const locale = getLocale(lang);

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date(today.getTime() - 86_400_000);
    const isToday = iso === today.toISOString().slice(0, 10);
    const isYest = iso === yest.toISOString().slice(0, 10);
    if (isToday) return t("past.today", lang);
    if (isYest) return t("past.yesterday", lang);
    return d.toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" });
  };

  const top = visits.slice(0, 5); // 최근 5회만 카드에 노출
  const allTotal = visits.reduce((s, v) => s + v.total, 0);

  return (
    <Card padding="md" className="border-[var(--color-line)]">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--color-navy-50)] text-[var(--color-navy-700)] inline-flex items-center justify-center">
          <ReceiptIcon className="w-4 h-4" />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-extrabold text-[var(--color-navy-900)]">
            {t("past.title", lang, { store: storeName })}
          </p>
          <p className="text-[11.5px] text-[var(--color-ink-500)] font-medium">
            {t("past.summary", lang, { n: visits.length, amount: fmtKRW(allTotal, lang) })}
          </p>
        </div>
      </div>

      <div className="divide-y divide-[var(--color-line)]">
        {top.map((v) => {
          const open = expandedDate === v.date;
          return (
            <div key={v.date} className="py-2.5 first:pt-0 last:pb-0">
              <button
                onClick={() => setExpandedDate(open ? null : v.date)}
                className="w-full flex items-center gap-3 text-left active:opacity-70"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-bold text-[var(--color-navy-900)]">{formatDate(v.date)}</p>
                  <p className="text-[11.5px] text-[var(--color-ink-500)] font-medium">
                    {t("past.orderCount", lang, { orders: v.orders.length, items: v.itemsCount })}
                  </p>
                </div>
                <span className="text-[14px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                  {fmtKRW(v.total, lang)}
                </span>
                <span className={cn(
                  "text-[10px] font-bold text-[var(--color-ink-500)] transition-transform",
                  open && "rotate-90"
                )}>
                  ▸
                </span>
              </button>

              {open && (
                <div className="mt-2 pl-2 border-l-2 border-[var(--color-navy-200)] space-y-2">
                  {v.orders.map((o) => (
                    <div key={o.id} className="text-[12.5px]">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10.5px] font-bold text-[var(--color-ink-500)] uppercase">
                          {new Date(o.createdAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="text-[11px] font-bold text-[var(--color-mint-700)]">{t("pay.paid", lang)}</span>
                      </div>
                      <ul className="space-y-0.5">
                        {o.items.map((it, i) => (
                          <li key={i} className="flex justify-between text-[var(--color-navy-900)]">
                            <span className="truncate mr-2">{it.name}{it.selectedOptions?.length ? ` (${it.selectedOptions.map((op) => op.optionName).join(" · ")})` : ""} × {it.quantity}</span>
                            <span className="font-semibold tabular-nums text-[var(--color-ink-600)]">
                              {fmtKRW(it.price * it.quantity, lang)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex justify-between mt-1 pt-1 border-t border-dashed border-[var(--color-line)]">
                        <span className="text-[11px] font-bold text-[var(--color-ink-500)]">{t("past.subtotal", lang)}</span>
                        <span className="text-[12px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                          {fmtKRW(o.totalAmount, lang)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {visits.length > top.length && (
        <p className="text-[11px] text-[var(--color-ink-500)] text-center mt-2 font-semibold">
          {t("past.more", lang, { n: visits.length - top.length })}
        </p>
      )}
    </Card>
  );
}

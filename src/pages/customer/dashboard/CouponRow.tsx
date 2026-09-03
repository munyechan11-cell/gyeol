import { CheckCircle2, Hourglass, XCircle } from "lucide-react";
import { useLanguage, t, getLocale } from "../../../lib/i18n";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { TIER_BADGE } from "../../../lib/tier";


export function CouponRow({
  coupon,
  tableNumber,
  onUse,
  onCancel,
}: {
  coupon: { id: string; type: string; description: string; descKey?: string; amount?: number; status: "available" | "pending" | "used"; usedAtTable?: number };
  tableNumber?: number;
  onUse: () => void;
  onCancel: () => void;
}) {
  const lang = useLanguage();
  const badge =
    TIER_BADGE[coupon.type as keyof typeof TIER_BADGE] ??
    { label: coupon.type, bg: "bg-[var(--color-navy-50)]", text: "text-[var(--color-navy-700)]" };
  return (
    <Card padding="md">
      <div className="flex items-start gap-3">
        <div className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${badge.bg} ${badge.text}`}>
          {badge.label}
        </div>
        {coupon.status === "pending" && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#b45309] font-semibold">
            <Hourglass className="w-3 h-3" /> {t("coupons.pending", lang)}
          </span>
        )}
        {coupon.status === "used" && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-ink-500)] font-semibold">
            <CheckCircle2 className="w-3 h-3" /> {t("coupons.used", lang)}
          </span>
        )}
      </div>
      <p className="text-[15px] font-bold text-[var(--color-navy-900)] mt-2">{coupon.descKey ? t(coupon.descKey, lang) : coupon.description}</p>
      {(coupon.amount ?? 0) > 0 && (
        <p className="text-[18px] font-extrabold text-[var(--color-mint-700)] mt-0.5 tabular-nums">
          {t("coupons.amountOff", lang, { amount: (coupon.amount as number).toLocaleString(getLocale(lang)) })}
        </p>
      )}
      {coupon.status === "available" && (
        <Button
          size="md"
          variant="mint"
          className="mt-3"
          onClick={onUse}
          disabled={!tableNumber}
        >
          {tableNumber ? t("coupons.useAtTable", lang, { n: tableNumber }) : t("coupons.needTable", lang)}
        </Button>
      )}
      {coupon.status === "pending" && (
        <Button size="md" variant="outline" className="mt-3" onClick={onCancel} leftIcon={<XCircle className="w-4 h-4" />}>
          {t("coupons.cancelRequest", lang)}
        </Button>
      )}
    </Card>
  );
}

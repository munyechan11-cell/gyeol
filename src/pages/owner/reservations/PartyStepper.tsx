import { Plus, Minus } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";

// ============================================================
export function PartyStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const lang = useLanguage();
  return (
    <div>
      <label className="block text-[12px] font-bold text-[var(--color-navy-800)] mb-1.5">{t("ores.field.party", lang)}</label>
      <div className="h-12 rounded-[12px] border-[1.5px] border-[var(--color-line)] flex items-center overflow-hidden">
        <button
          type="button"
          onClick={() => onChange(value - 1)}
          disabled={value <= 1}
          className="w-12 h-full inline-flex items-center justify-center text-[var(--color-navy-700)] hover:bg-[var(--color-navy-50)] disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={t("ores.partyDec", lang)}
        >
          <Minus className="w-4 h-4" />
        </button>
        <div className="flex-1 text-center font-extrabold text-[17px] text-[var(--color-navy-900)] tabular-nums">
          {t("ores.partyN", lang, { n: value })}
        </div>
        <button
          type="button"
          onClick={() => onChange(value + 1)}
          disabled={value >= 99}
          className="w-12 h-full inline-flex items-center justify-center text-[var(--color-navy-700)] hover:bg-[var(--color-navy-50)] disabled:opacity-40"
          aria-label={t("ores.partyInc", lang)}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

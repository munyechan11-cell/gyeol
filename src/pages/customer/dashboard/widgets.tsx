import { useEffect, useState } from "react";
import { Plus, Minus } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import { Card } from "../../../components/ui/Card";


export function SessionTimer({ start }: { start: string | null }) {
  const lang = useLanguage();
  const [elapsed, setElapsed] = useState(() => (start ? Date.now() - new Date(start).getTime() : 0));
  useEffect(() => {
    if (!start) {
      setElapsed(0);
      return;
    }
    setElapsed(Date.now() - new Date(start).getTime());
    const id = window.setInterval(
      () => setElapsed(Date.now() - new Date(start).getTime()),
      1000
    );
    return () => clearInterval(id);
  }, [start]);
  const m = Math.floor(elapsed / 60000);
  const s = Math.floor((elapsed % 60000) / 1000);
  return (
    <p className="text-[12px] text-[var(--color-mint-700)] font-semibold tabular-nums">
      {t("home.useTime", lang, { m, s: s.toString().padStart(2, "0") })}
    </p>
  );
}

export function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="sm" className="text-center">
      <p className="text-[12px] text-[var(--color-ink-600)] font-semibold mb-0.5">{label}</p>
      <p className="text-[16px] font-extrabold text-[var(--color-navy-900)] tabular-nums">{value}</p>
    </Card>
  );
}

export function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-bg)] rounded-xl px-3 py-2.5">
      <p className="text-[11px] text-[var(--color-ink-600)] font-semibold uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-[14px] font-bold text-[var(--color-navy-900)]">{value}</p>
    </div>
  );
}

export function QtyStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const lang = useLanguage();
  if (value === 0) {
    return (
      <button
        onClick={() => onChange(1)}
        className="w-9 h-9 rounded-full bg-[var(--color-navy-700)] text-white inline-flex items-center justify-center shadow-[var(--shadow-navy)] active:scale-95"
        aria-label={t("menu.add", lang)}
      >
        <Plus className="w-4 h-4" />
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => onChange(value - 1)}
        className="w-10 h-10 rounded-full bg-[var(--color-navy-50)] text-[var(--color-navy-700)] inline-flex items-center justify-center active:scale-95"
        aria-label={t("menu.decrease", lang)}
      >
        <Minus className="w-4 h-4" />
      </button>
      <span className="text-[15px] font-extrabold text-[var(--color-navy-900)] w-6 text-center">{value}</span>
      <button
        onClick={() => onChange(value + 1)}
        className="w-10 h-10 rounded-full bg-[var(--color-navy-700)] text-white inline-flex items-center justify-center active:scale-95"
        aria-label={t("menu.increase", lang)}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

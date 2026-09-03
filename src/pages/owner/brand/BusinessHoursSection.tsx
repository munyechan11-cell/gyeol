import { Sec, ToggleSwitch } from "./controls";
import { useEffect, useMemo, useState } from "react";
import { Save, AlertCircle, Clock } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import { cn } from "../../../lib/cn";
import { Button } from "../../../components/ui/Button";
import { DAY_LABELS, defaultBusinessHours, getStoreOpenStatus, summarizeStatus } from "../../../lib/businessHours";
import type { BusinessHours } from "../../../lib/types";

// ============================================================
export function BusinessHoursSection({
  owner,
  onSave,
}: {
  owner: { businessHours?: BusinessHours; temporarilyClosed?: boolean; temporaryClosedReason?: string } | null;
  onSave: (patch: { businessHours?: BusinessHours; temporarilyClosed?: boolean; temporaryClosedReason?: string }) => Promise<void>;
}) {
  const lang = useLanguage();
  const init = useMemo(() => owner?.businessHours ?? defaultBusinessHours(), [owner?.businessHours]);
  const [bh, setBh] = useState<BusinessHours>(init);
  const [tempClosed, setTempClosed] = useState(!!owner?.temporarilyClosed);
  const [tempReason, setTempReason] = useState(owner?.temporaryClosedReason ?? "");
  const [closedDate, setClosedDate] = useState("");

  useEffect(() => setBh(init), [init]);
  useEffect(() => { setTempClosed(!!owner?.temporarilyClosed); }, [owner?.temporarilyClosed]);
  useEffect(() => { setTempReason(owner?.temporaryClosedReason ?? ""); }, [owner?.temporaryClosedReason]);

  const status = getStoreOpenStatus(owner);

  const updateWeekly = (idx: number, patch: Partial<NonNullable<BusinessHours["weekly"]>[number]>) => {
    const weekly = [...(bh.weekly ?? [])];
    weekly[idx] = { ...weekly[idx], ...patch };
    setBh({ ...bh, weekly });
  };

  const addClosedDate = () => {
    if (!closedDate) return;
    const dates = Array.from(new Set([...(bh.closedDates ?? []), closedDate]));
    setBh({ ...bh, closedDates: dates });
    setClosedDate("");
  };
  const removeClosedDate = (d: string) => {
    setBh({ ...bh, closedDates: (bh.closedDates ?? []).filter((x) => x !== d) });
  };

  return (
    <Sec title={t("obsBh.title", lang)}>
      <div className="space-y-3">
        {/* 현재 상태 카드 */}
        <div className={cn(
          "p-3.5 rounded-[14px] flex items-center gap-2.5",
          status.open
            ? "bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]"
            : "bg-[#fef2f2] border border-[var(--color-danger)]/40"
        )}>
          <span className={cn("w-2 h-2 rounded-full", status.open ? "bg-[var(--color-mint-500)] animate-pulse" : "bg-[var(--color-danger)]")} />
          <p className={cn("text-[13px] font-extrabold", status.open ? "text-[var(--color-mint-700)]" : "text-[var(--color-danger)]")}>
            {t("obsBh.current", lang, { status: summarizeStatus(status) })}
          </p>
        </div>

        {/* 24시 영업 */}
        <div className="p-3 rounded-[12px] border border-[var(--color-line)] flex items-center gap-3">
          <Clock className="w-4 h-4 text-[var(--color-navy-700)]" />
          <div className="flex-1">
            <p className="text-[13px] font-bold text-[var(--color-navy-900)]">{t("obsBh.h24.title", lang)}</p>
            <p className="text-[11px] text-[var(--color-ink-500)]">{t("obsBh.h24.desc", lang)}</p>
          </div>
          <ToggleSwitch value={!!bh.open24h} onChange={(v) => setBh({ ...bh, open24h: v })} />
        </div>

        {/* 요일별 시간 */}
        {!bh.open24h && (
          <div className="rounded-[12px] border border-[var(--color-line)] divide-y divide-[var(--color-line)] bg-white">
            {DAY_LABELS.map((label, idx) => {
              const w = bh.weekly?.[idx] ?? { open: "09:00", close: "22:00", closed: false };
              return (
                <div key={idx} className="px-3 py-2.5 flex items-center gap-2 flex-wrap">
                  <span className="w-8 text-[12.5px] font-extrabold text-[var(--color-navy-900)]">{label}</span>
                  {w.closed ? (
                    <span className="text-[12px] font-bold text-[var(--color-danger)] flex-1">{t("obsBh.day.closed", lang)}</span>
                  ) : (
                    <>
                      <input
                        type="time"
                        value={w.open ?? "09:00"}
                        onChange={(e) => updateWeekly(idx, { open: e.target.value })}
                        className="h-9 px-2 rounded-md border border-[var(--color-line)] text-[13px] font-semibold tabular-nums"
                      />
                      <span className="text-[11px] text-[var(--color-ink-500)]">~</span>
                      <input
                        type="time"
                        value={w.close ?? "22:00"}
                        onChange={(e) => updateWeekly(idx, { close: e.target.value })}
                        className="h-9 px-2 rounded-md border border-[var(--color-line)] text-[13px] font-semibold tabular-nums"
                      />
                      {w.breakStart || w.breakEnd ? (
                        <span className="text-[10.5px] text-[var(--color-warn)] font-bold">
                          {t("obsBh.day.breakLine", lang, { start: w.breakStart ?? "??", end: w.breakEnd ?? "??" })}
                        </span>
                      ) : (
                        <button
                          onClick={() => updateWeekly(idx, { breakStart: "15:00", breakEnd: "17:00" })}
                          className="text-[10.5px] font-bold text-[var(--color-navy-700)] hover:underline"
                        >
                          {t("obsBh.day.addBreak", lang)}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => updateWeekly(idx, { closed: !w.closed })}
                    className={cn(
                      "ml-auto text-[10.5px] font-bold px-2 py-1 rounded-md",
                      w.closed ? "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]" : "bg-[#fef2f2] text-[var(--color-danger)]"
                    )}
                  >
                    {w.closed ? t("obsBh.day.toOpen", lang) : t("obsBh.day.toClosed", lang)}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* 임시 휴무일 (날짜) */}
        <div className="rounded-[12px] border border-[var(--color-line)] p-3">
          <p className="text-[12.5px] font-bold text-[var(--color-navy-900)] mb-2">{t("obsBh.closedDates.title", lang)}</p>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="date"
              value={closedDate}
              onChange={(e) => setClosedDate(e.target.value)}
              className="flex-1 h-9 px-2 rounded-md border border-[var(--color-line)] text-[13px] font-semibold"
            />
            <button
              onClick={addClosedDate}
              disabled={!closedDate}
              className="h-9 px-3 rounded-md bg-[var(--color-navy-700)] text-white text-[12px] font-bold disabled:opacity-40"
            >
              {t("obsBh.closedDates.add", lang)}
            </button>
          </div>
          {(bh.closedDates ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(bh.closedDates ?? []).sort().map((d) => (
                <span key={d} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--color-ink-50)] text-[11px] font-bold text-[var(--color-ink-700)]">
                  {d}
                  <button onClick={() => removeClosedDate(d)} className="text-[var(--color-danger)] hover:text-[#a52323]">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 임시 마감 토글 */}
        <div className="rounded-[12px] border-2 border-[var(--color-warn)]/30 bg-[#fff8e6] p-3">
          <div className="flex items-center gap-3 mb-2">
            <AlertCircle className="w-4 h-4 text-[var(--color-warn)]" />
            <div className="flex-1">
              <p className="text-[12.5px] font-bold text-[#b07b00]">{t("obsBh.emergency.title", lang)}</p>
              <p className="text-[10.5px] text-[#b07b00]/80">{t("obsBh.emergency.desc", lang)}</p>
            </div>
            <ToggleSwitch value={tempClosed} onChange={async (v) => {
              setTempClosed(v);
              await onSave({ temporarilyClosed: v, temporaryClosedReason: v ? tempReason : "" });
            }} />
          </div>
          {tempClosed && (
            <input
              type="text"
              placeholder={t("obsBh.emergency.reasonPh", lang)}
              value={tempReason}
              onChange={(e) => setTempReason(e.target.value)}
              onBlur={() => onSave({ temporarilyClosed: true, temporaryClosedReason: tempReason })}
              className="w-full h-9 px-2.5 rounded-md border border-[#f0b400]/40 bg-white text-[12.5px] font-semibold"
            />
          )}
        </div>

        <Button block onClick={() => onSave({ businessHours: bh })} leftIcon={<Save className="w-4 h-4" />}>
          {t("obsBh.save", lang)}
        </Button>
      </div>
    </Sec>
  );
}

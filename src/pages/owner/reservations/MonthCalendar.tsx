import { localTodayStr } from "../../../lib/date";
import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Reservation } from "../../../lib/types";
import { cn } from "../../../lib/cn";
import { useLanguage, t } from "../../../lib/i18n";

// MonthCalendar — 월간 예약 캘린더
// 각 셀에 예약 개수 배지 + 가장 가까운 시간 미리보기.
// 셀 클릭 시 그 날 예약 리스트로 필터.
// ============================================================
export function MonthCalendar({
  month,
  onPrev,
  onNext,
  onToday,
  reservationsByDate,
  onDayClick,
  selectedDate,
  locale,
}: {
  month: Date;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  reservationsByDate: Map<string, Reservation[]>;
  onDayClick: (dateStr: string) => void;
  selectedDate: string | null;
  locale: string;
}) {
  const lang = useLanguage();
  const year = month.getFullYear();
  const m = month.getMonth();
  // 그 달의 1일 요일(0=일) — 한국 달력 관습 따라 일요일 시작
  const firstDay = new Date(year, m, 1).getDay();
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const todayStrLocal = localTodayStr(new Date());

  // 셀(42칸 = 6주) 생성
  const cells: Array<{ dateStr: string; day: number; inMonth: boolean }> = [];
  // 앞쪽 빈칸 — 전달 마지막 며칠
  const prevMonthLastDay = new Date(year, m, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    const d = new Date(year, m - 1, day);
    cells.push({ dateStr: localTodayStr(d), day, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, m, d);
    cells.push({ dateStr: localTodayStr(dt), day: d, inMonth: true });
  }
  // 뒤쪽 빈칸 — 다음달 시작
  let nextDay = 1;
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const d = new Date(year, m + 1, nextDay);
    cells.push({ dateStr: localTodayStr(d), day: nextDay, inMonth: false });
    nextDay++;
    if (cells.length >= 42) break;
  }

  // 요일 헤더 — locale 기반
  const weekdayLabels = useMemo(() => {
    const base = new Date(2024, 0, 7); // 일요일
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d.toLocaleDateString(locale, { weekday: "short" });
    });
  }, [locale]);

  return (
    <div className="mt-4 bg-white rounded-[16px] border border-[var(--color-line)] overflow-hidden">
      {/* 헤더: 월 표시 + 이전/다음/오늘 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-line)]">
        <h3 className="text-[16px] font-extrabold text-[var(--color-navy-900)]">
          {month.toLocaleDateString(locale, { year: "numeric", month: "long" })}
        </h3>
        <div className="ml-auto inline-flex items-center gap-1">
          <button
            onClick={onPrev}
            aria-label={t("ores.cal.prev", lang)}
            className="w-9 h-9 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center justify-center"
          >
            <ChevronLeft className="w-4 h-4 text-[var(--color-navy-800)]" />
          </button>
          <button
            onClick={onToday}
            className="h-9 px-3 rounded-full bg-[var(--color-bg)] text-[var(--color-navy-800)] text-[12px] font-bold hover:bg-[var(--color-navy-50)]"
          >
            {t("ores.cal.today", lang)}
          </button>
          <button
            onClick={onNext}
            aria-label={t("ores.cal.next", lang)}
            className="w-9 h-9 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center justify-center"
          >
            <ChevronRight className="w-4 h-4 text-[var(--color-navy-800)]" />
          </button>
        </div>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 border-b border-[var(--color-line)] bg-[var(--color-bg)]">
        {weekdayLabels.map((w, i) => (
          <div
            key={i}
            className={cn(
              "py-1.5 text-center text-[11px] font-bold uppercase tracking-wider",
              i === 0 ? "text-[var(--color-danger)]" : i === 6 ? "text-[var(--color-navy-600)]" : "text-[var(--color-ink-500)]"
            )}
          >
            {w}
          </div>
        ))}
      </div>

      {/* 셀 그리드 */}
      <div className="grid grid-cols-7">
        {cells.map((c, i) => {
          const items = reservationsByDate.get(c.dateStr) ?? [];
          const confirmed = items.filter((r) => r.status === "confirmed");
          const isToday = c.dateStr === todayStrLocal;
          const isSelected = selectedDate === c.dateStr;
          const dayOfWeek = i % 7;
          return (
            <button
              key={`${c.dateStr}-${i}`}
              onClick={() => onDayClick(c.dateStr)}
              className={cn(
                "min-h-[84px] border-t border-l border-[var(--color-line-soft)] p-1.5 text-left transition-colors",
                !c.inMonth && "bg-[var(--color-bg)]/40 opacity-50",
                isSelected && "bg-[var(--color-mint-50)] ring-2 ring-[var(--color-mint-500)] ring-inset",
                !isSelected && c.inMonth && "hover:bg-[var(--color-navy-50)]",
                i % 7 === 0 && "border-l-0"
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "text-[12px] font-bold tabular-nums",
                    isToday
                      ? "inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-navy-700)] text-white"
                      : dayOfWeek === 0
                      ? "text-[var(--color-danger)]"
                      : dayOfWeek === 6
                      ? "text-[var(--color-navy-700)]"
                      : "text-[var(--color-ink-700)]"
                  )}
                >
                  {c.day}
                </span>
                {confirmed.length > 0 && (
                  <span className="text-[10px] font-extrabold bg-[var(--color-mint-100)] text-[var(--color-mint-700)] px-1.5 rounded-full tabular-nums">
                    {confirmed.length}
                  </span>
                )}
              </div>
              {/* 시간 미리보기 — 최대 2건 */}
              {confirmed.slice(0, 2).map((r) => (
                <div
                  key={r.id}
                  className="mt-1 text-[10px] font-bold text-[var(--color-navy-800)] truncate"
                >
                  <span className="tabular-nums">{r.time}</span>{" "}
                  <span className="text-[var(--color-ink-600)] font-semibold">{r.customerName.slice(0, 4)}</span>
                </div>
              ))}
              {confirmed.length > 2 && (
                <div className="mt-0.5 text-[10px] font-bold text-[var(--color-ink-500)]">
                  {t("ores.cal.moreN", lang, { n: confirmed.length - 2 })}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// PartyStepper — 인원수 + / − 스테퍼 (큰 가시성)

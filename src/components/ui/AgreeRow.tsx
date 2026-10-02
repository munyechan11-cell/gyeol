/**
 * 약관 한 줄 — 체크박스 + 필수/선택 라벨 + '왜 필요한가요' 설명 + '보기' 버튼.
 * 고객 가입, 사장님 가입, 기능 최초 사용 동의에서 같이 쓴다.
 */
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";
import { useLanguage, t } from "../../lib/i18n";
import type { TermDoc } from "../../lib/terms";

export function AgreeRow({
  term,
  checked,
  onToggle,
  onView,
}: {
  term: TermDoc;
  checked: boolean;
  onToggle: () => void;
  onView: () => void;
}) {
  const lang = useLanguage();
  return (
    <div className="rounded-[12px] border border-[var(--color-line)] bg-white p-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "w-6 h-6 rounded-md border-[1.5px] flex items-center justify-center transition-colors shrink-0",
            checked ? "bg-[var(--color-navy-700)] border-[var(--color-navy-700)]" : "border-[var(--color-ink-300)] bg-white"
          )}
          aria-label={`${term.title}`}
          aria-checked={checked}
          role="checkbox"
        >
          {checked && <Check className="w-4 h-4 text-white" />}
        </button>
        <button type="button" onClick={onToggle} className="flex-1 min-w-0 text-left">
          <span className={cn(
            "text-[11px] font-extrabold mr-1.5 px-1.5 py-0.5 rounded",
            term.required
              ? "bg-[#fef2f2] text-[var(--color-danger)]"
              : "bg-[var(--color-ink-50)] text-[var(--color-ink-600)]"
          )}>
            {term.required ? t("login.required", lang) : t("login.optional", lang)}
          </span>
          <span className="text-[14px] font-bold text-[var(--color-navy-900)]">{term.title}</span>
        </button>
        <button
          type="button"
          onClick={onView}
          className="text-[11.5px] font-bold text-[var(--color-navy-700)] hover:underline px-2 py-1 rounded shrink-0"
        >
          {t("login.view", lang)}
        </button>
      </div>
      {/* '왜 필요한가요' 한 줄 설명 */}
      <p className="text-[11.5px] text-[var(--color-ink-600)] mt-1.5 ml-9 leading-relaxed">
        {term.why}
      </p>
    </div>
  );
}

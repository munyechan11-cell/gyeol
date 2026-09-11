import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { t } from "../../../lib/i18n";

// 8-10: 접기 카드 + 선택적 그룹 헤더. defaultOpen 기본 false(처음엔 모두 접힘). group 주면 위에 그룹 제목.
export function Sec({
  title,
  children,
  defaultOpen = false,
  group,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  group?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      {group && (
        <h3 className="text-[12px] font-extrabold text-[var(--color-navy-700)] tracking-wide px-1 mt-7 mb-1">{group}</h3>
      )}
      <div className="mt-2.5 rounded-2xl border border-[var(--color-line)] bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 px-4 h-12 text-left active:bg-[var(--color-bg)]"
        >
          <span className="text-[13.5px] font-bold text-[var(--color-navy-900)]">{title}</span>
          <ChevronDown className={`w-4 h-4 text-[var(--color-ink-400)] shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && <div className="px-4 pb-4 pt-2 space-y-3 border-t border-[var(--color-line-soft)]">{children}</div>}
      </div>
    </>
  );
}

export function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 rounded-[12px] text-[13px] font-bold ${
        active
          ? "bg-[var(--color-navy-700)] text-white shadow-[var(--shadow-navy)]"
          : "bg-white border border-[var(--color-line)] text-[var(--color-ink-700)]"
      }`}
    >
      {children}
    </button>
  );
}

// 라벨 없는 작은 토글 — 카드 우측 정렬용
export function ToggleSwitch({ value, onChange }: { value: boolean; onChange: (v: boolean) => void | Promise<void> }) {
  return (
    <button
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
      className={`w-11 h-6 rounded-full relative transition-colors shrink-0 ${
        value ? "bg-[var(--color-navy-700)]" : "bg-[var(--color-ink-100)]"
      }`}
    >
      <span
        className={`absolute top-0.5 ${value ? "left-[22px]" : "left-0.5"} w-5 h-5 rounded-full bg-white shadow transition-all`}
      />
    </button>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-full flex items-center gap-3 py-3 text-left"
    >
      <span
        className={`w-11 h-6 rounded-full relative transition-colors ${
          value ? "bg-[var(--color-navy-700)]" : "bg-[var(--color-ink-100)]"
        }`}
      >
        <span
          className={`absolute top-0.5 ${value ? "left-[22px]" : "left-0.5"} w-5 h-5 rounded-full bg-white shadow transition-all`}
        />
      </span>
      <span className="text-[14px] font-semibold text-[var(--color-navy-900)]">{label}</span>
    </button>
  );
}

// ============================================================
// 영수증 자동 인쇄 브릿지 — 사장님 PC 에이전트 페어링 섹션 (옵션 B)

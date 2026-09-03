import type { TableStatus } from "../../../lib/types";


// 8단계 흐름 — 다음 상태 순환 (테이블 편집 페이지의 카드에서 빠른 토글용)
// 라벨은 tableFlow STATUS_LABEL 키와 매핑되도록 labelKey 만 보관
export const STATUS_FLOW: Record<TableStatus, { next: TableStatus; labelKey: string; cls: string }> = {
  available: { next: "setup",    labelKey: "tflow.available", cls: "bg-white border border-[var(--color-line)] text-[var(--color-ink-600)]" },
  reserved:  { next: "setup",    labelKey: "tflow.reserved",  cls: "bg-[#f1ecff] text-[#6d4cdf]" },
  setup:     { next: "occupied", labelKey: "tflow.setup",     cls: "bg-[#fff8e6] text-[#b07b00]" },
  occupied:  { next: "dining",   labelKey: "tflow.occupied",  cls: "bg-[var(--color-mint-50)] text-[var(--color-mint-700)]" },
  dining:    { next: "paid",     labelKey: "tflow.dining",    cls: "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]" },
  paid:      { next: "cleaning", labelKey: "tflow.paid",      cls: "bg-[var(--color-navy-100)] text-[var(--color-navy-700)]" },
  cleaning:  { next: "available",labelKey: "tflow.cleaning",  cls: "bg-[#fff1e0] text-[var(--color-warn)]" },
  dirty:     { next: "available",labelKey: "tflow.cleaning",  cls: "bg-[#fff1e0] text-[var(--color-warn)]" },
};

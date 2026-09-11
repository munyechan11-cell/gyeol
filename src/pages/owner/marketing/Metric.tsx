


export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--color-bg)] p-3 text-center">
      <p className="text-[11px] text-[var(--color-ink-500)]">{label}</p>
      <p className="text-[14px] font-extrabold tabular-nums mt-0.5 text-[var(--color-navy-900)]">{value}</p>
    </div>
  );
}

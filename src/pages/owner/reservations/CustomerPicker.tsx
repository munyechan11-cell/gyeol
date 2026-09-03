import { useMemo, useState } from "react";
import { UserPlus, User as UserIcon, Search, X } from "lucide-react";
import { formatPhoneNumber, digitsOnly } from "../../../lib/ids";
import type { User } from "../../../lib/types";
import { cn } from "../../../lib/cn";
import { useLanguage, t } from "../../../lib/i18n";

// ============================================================
export function CustomerPicker({
  value,
  onChange,
  customers,
  previousGuests,
}: {
  value: { customerName: string; customerPhone: string; customerId?: string; isGuest: boolean };
  onChange: (v: Partial<{ customerName: string; customerPhone: string; customerId?: string; isGuest: boolean }>) => void;
  customers: User[];
  previousGuests: { name: string; phone: string }[];
}) {
  const lang = useLanguage();
  const [query, setQuery] = useState(value.customerName);
  const [open, setOpen] = useState(false);
  // 게스트 추가 인라인 폼 — 이름·전화 한 번에 입력
  const [guestMode, setGuestMode] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestError, setGuestError] = useState("");

  // 입력에 따라 후보 필터링 — 단골 우선, 그 다음 이전 예약 손님
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qDigits = digitsOnly(query);
    const customerHits = customers
      .filter((u) => {
        if (!q) return true;
        const nm = (u.name || "").toLowerCase();
        const ph = digitsOnly(u.phone || "");
        return nm.includes(q) || (qDigits && ph.includes(qDigits));
      })
      .slice(0, 6)
      .map((u) => ({ kind: "registered" as const, id: u.id, name: u.name, phone: u.phone }));

    const guestHits = previousGuests
      .filter((g) => {
        if (!q) return false;
        const nm = (g.name || "").toLowerCase();
        const ph = digitsOnly(g.phone || "");
        // 등록 고객과 같은 이름·전화는 중복 제외
        if (customerHits.some((c) => c.name === g.name || (c.phone && digitsOnly(c.phone) === ph))) return false;
        return nm.includes(q) || (qDigits && ph.includes(qDigits));
      })
      .slice(0, 4)
      .map((g) => ({ kind: "guest-prev" as const, id: g.phone || g.name, name: g.name, phone: g.phone }));

    return [...customerHits, ...guestHits];
  }, [query, customers, previousGuests]);

  // 외부에서 value 가 변하면 query 동기화 (수정 모드)
  // ※ value.customerName 만 추적 — 너무 자주 갱신되지 않게
  // (Reservations.tsx 가 controlled component 로 잘 흐름)

  const selectCustomer = (c: { id: string; name: string; phone?: string }) => {
    onChange({
      customerId: c.id,
      customerName: c.name,
      customerPhone: c.phone ? formatPhoneNumber(c.phone) : "",
      isGuest: false,
    });
    setQuery(c.name);
    setOpen(false);
  };

  const startGuestForm = () => {
    // 검색어를 이름 기본값으로 (게스트 prefix 없이)
    const prefix = t("ores.guestPrefix", lang);
    const raw = query.trim().replace(new RegExp(`^${prefix}\\s*`), "");
    setGuestName(raw);
    setGuestPhone("");
    setGuestError("");
    setGuestMode(true);
    setOpen(false);
  };

  const confirmGuest = () => {
    const name = guestName.trim();
    const phoneDigits = digitsOnly(guestPhone);
    if (!name) { setGuestError(t("ores.guestErr.name", lang)); return; }
    if (phoneDigits.length < 10) { setGuestError(t("ores.guestErr.phone", lang)); return; }
    const prefix = t("ores.guestPrefix", lang);
    onChange({
      customerId: undefined,
      customerName: name.startsWith(prefix) ? name : `${prefix} ${name}`,
      customerPhone: formatPhoneNumber(guestPhone),
      isGuest: true,
    });
    setQuery("");
    setGuestName("");
    setGuestPhone("");
    setGuestError("");
    setGuestMode(false);
  };

  const cancelGuest = () => {
    setGuestMode(false);
    setGuestName("");
    setGuestPhone("");
    setGuestError("");
  };

  const clearPick = () => {
    onChange({ customerId: undefined, customerName: "", customerPhone: "", isGuest: false });
    setQuery("");
    setOpen(true);
  };

  const isPicked = !!value.customerId || (value.isGuest && !!value.customerName);

  return (
    <div className="relative">
      <label className="block text-[12px] font-bold text-[var(--color-navy-800)] mb-1.5">{t("ores.customer", lang)}</label>

      {/* 게스트 추가 인라인 폼 — 이름·전화 동시 입력 */}
      {guestMode ? (
        <div className="rounded-[14px] border-2 border-[#f0b400] bg-[#fff8e6] p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#f0b400] text-white inline-flex items-center justify-center">
              <UserPlus className="w-4 h-4" />
            </div>
            <p className="text-[13px] font-extrabold text-[#b07b00] flex-1">
              {t("ores.guestPanel", lang)}
            </p>
          </div>
          <input
            type="text"
            value={guestName}
            onChange={(e) => { setGuestName(e.target.value); setGuestError(""); }}
            placeholder={t("ores.guestNamePh", lang)}
            autoFocus
            className="w-full h-11 px-3 rounded-[10px] border-[1.5px] border-[#f0b400]/40 bg-white text-[14px] font-semibold focus:border-[#f0b400] focus:outline-none"
          />
          <input
            type="tel"
            value={guestPhone}
            onChange={(e) => { setGuestPhone(formatPhoneNumber(e.target.value)); setGuestError(""); }}
            inputMode="numeric"
            placeholder={t("ores.guestPhonePh", lang)}
            className="w-full h-11 px-3 rounded-[10px] border-[1.5px] border-[#f0b400]/40 bg-white text-[14px] font-semibold tabular-nums focus:border-[#f0b400] focus:outline-none"
          />
          {guestError && (
            <p className="text-[11.5px] font-bold text-[var(--color-danger)]">{guestError}</p>
          )}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={cancelGuest}
              className="h-10 rounded-[10px] bg-white border-[1.5px] border-[var(--color-line)] text-[var(--color-ink-700)] font-bold text-[13px]"
            >
              {t("ores.guestCancel", lang)}
            </button>
            <button
              type="button"
              onClick={confirmGuest}
              className="h-10 rounded-[10px] bg-[#f0b400] text-white font-extrabold text-[13px]"
            >
              {t("ores.guestConfirm", lang)}
            </button>
          </div>
        </div>
      ) : isPicked ? (
        // 선택 완료 칩
        <div
          className={cn(
            "w-full h-12 px-3 rounded-[12px] border-[1.5px] flex items-center gap-2.5",
            value.isGuest
              ? "border-[#f0b400] bg-[#fff8e6]"
              : "border-[var(--color-mint-300)] bg-[var(--color-mint-50)]"
          )}
        >
          <div className={cn(
            "w-8 h-8 rounded-full inline-flex items-center justify-center font-extrabold text-[12px]",
            value.isGuest
              ? "bg-[#f0b400] text-white"
              : "bg-[var(--color-mint-500)] text-white"
          )}>
            {value.isGuest ? "G" : (value.customerName?.[0] ?? "?")}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-extrabold text-[var(--color-navy-900)] truncate">
              {value.customerName}
              {value.isGuest && (
                <span className="ml-1.5 text-[10.5px] font-bold text-[#b07b00]">{t("ores.unregistered", lang)}</span>
              )}
            </p>
            {value.customerPhone && (
              <p className="text-[11.5px] text-[var(--color-ink-500)] truncate">{value.customerPhone}</p>
            )}
          </div>
          <button
            type="button"
            onClick={clearPick}
            className="w-8 h-8 rounded-full hover:bg-white/60 inline-flex items-center justify-center"
            aria-label={t("ores.clearAria", lang)}
          >
            <X className="w-4 h-4 text-[var(--color-ink-500)]" />
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-400)]">
              <Search className="w-4 h-4" />
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); onChange({ customerName: e.target.value }); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 150)}
              placeholder={t("ores.searchPlaceholder", lang)}
              className="w-full h-12 pl-9 pr-3 rounded-[12px] border-[1.5px] border-[var(--color-line)] text-[14px] focus:border-[var(--color-navy-700)] focus:outline-none"
            />
          </div>

          {open && (
            <div className="absolute z-10 left-0 right-0 mt-1.5 bg-white rounded-[12px] border border-[var(--color-line)] shadow-[var(--shadow-lifted)] overflow-hidden max-h-72 overflow-y-auto">
              {matches.length > 0 && (
                <div className="px-2 py-1.5 text-[10.5px] font-bold text-[var(--color-ink-500)] uppercase tracking-wider border-b border-[var(--color-line)]">
                  {t("ores.registered", lang)}
                </div>
              )}
              {matches.map((m) => (
                <button
                  key={`${m.kind}-${m.id}`}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}  // blur 차단
                  onClick={() => selectCustomer({ id: m.id, name: m.name, phone: m.phone })}
                  className="w-full px-3 py-2.5 hover:bg-[var(--color-navy-50)] flex items-center gap-2.5 text-left"
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full inline-flex items-center justify-center font-extrabold text-[12px]",
                    m.kind === "registered"
                      ? "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]"
                      : "bg-[#fff8e6] text-[#b07b00]"
                  )}>
                    {m.name?.[0] ?? "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13.5px] font-bold text-[var(--color-navy-900)] truncate">
                      {m.name}
                      {m.kind === "guest-prev" && (
                        <span className="ml-1.5 text-[10.5px] font-bold text-[#b07b00]">{t("ores.previousGuest", lang)}</span>
                      )}
                    </p>
                    {m.phone && (
                      <p className="text-[11.5px] text-[var(--color-ink-500)] truncate">{m.phone}</p>
                    )}
                  </div>
                </button>
              ))}

              {/* 게스트로 추가 옵션 — 항상 노출. 클릭 시 이름·전화 동시 입력 폼으로 전환 */}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={startGuestForm}
                className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left border-t border-[var(--color-line)] hover:bg-[#fff8e6]"
              >
                <div className="w-8 h-8 rounded-full bg-[#f0b400] text-white inline-flex items-center justify-center">
                  <UserPlus className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-bold text-[#b07b00] truncate">
                    {t("ores.addGuest", lang)}
                  </p>
                  <p className="text-[11px] text-[var(--color-ink-500)]">
                    {t("ores.addGuestDesc", lang)}
                  </p>
                </div>
              </button>

              {matches.length === 0 && query.trim() && (
                <div className="px-3 py-2.5 text-[12px] text-[var(--color-ink-500)] flex items-center gap-2 bg-[var(--color-bg)]">
                  <UserIcon className="w-3.5 h-3.5" />
                  {t("ores.noMatch", lang)}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================

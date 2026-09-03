import { useMemo, useState } from "react";
import { Plus, Trash2, Phone, X, Monitor, MessageCircle, MessageSquare, Bell, CalendarDays, List as ListIcon } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useStore } from "../../store/store";
import { formatPhoneNumber, digitsOnly } from "../../lib/ids";
import type { Reservation, ReservationStatus } from "../../lib/types";
import { showToast } from "../../lib/toast";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { useModalChrome } from "../../lib/useModalChrome";
import { useLanguage, t, getLocale } from "../../lib/i18n";
import { sendKakaoMessage, sendPhysicalSms } from "../../lib/messaging";
import { CustomerPicker } from "./reservations/CustomerPicker";
import { MonthCalendar } from "./reservations/MonthCalendar";
import { PartyStepper } from "./reservations/PartyStepper";
import { localTodayStr } from "../../lib/date";

const STATUS_KEYS: Record<ReservationStatus, string> = {
  confirmed: "ores.status.confirmed",
  completed: "ores.status.completed",
  cancelled: "ores.status.cancelled",
  "no-show": "ores.status.noshow",
};
const STATUS_COLORS: Record<ReservationStatus, string> = {
  confirmed: "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]",
  completed: "bg-[var(--color-ink-50)] text-[var(--color-ink-500)]",
  cancelled: "bg-[var(--color-ink-50)] text-[var(--color-ink-500)]",
  "no-show": "bg-[#fef2f2] text-[var(--color-danger)]",
};

interface Draft {
  id?: string;
  date: string;
  time: string;
  tableNumber: string;
  partySize: string;
  customerName: string;
  customerPhone: string;
  memo: string;
  /** 등록된 고객을 선택한 경우의 user.id (게스트면 undefined) */
  customerId?: string;
  /** 게스트 모드 — 등록 안 된 손님이면 true */
  isGuest?: boolean;
}

// 로컬 자정 기준 'YYYY-MM-DD' — KST/UTC 차이로 달력이 어긋나지 않게.
const todayStr = () => localTodayStr(new Date());

const newDraft = (): Draft => ({
  date: todayStr(),
  time: "19:00",
  tableNumber: "1",
  partySize: "2",
  customerName: "",
  customerPhone: "",
  memo: "",
});

export default function OwnerReservations() {
  const { effectiveStoreId, reservations, users, visits, currentUser, addReservation, updateReservation, deleteReservation } = useStore();
  const storeId = effectiveStoreId;
  const lang = useLanguage();
  const locale = getLocale(lang);

  // 매장 이름 — 메시지 템플릿에서 사용
  const storeOwner = users.find((u) => u.id === storeId);
  const storeName = storeOwner?.restaurantName ?? currentUser?.restaurantName ?? "결";

  // 예약을 카카오톡/SMS로 보내는 핸들러.
  // 반환값: 성공 시 true. 일괄 발송에서 정확한 카운트를 위해 boolean 반환.
  // silent=true 면 토스트 출력 생략 (일괄 발송에서 마지막에 하나만 띄우기).
  const sendMessage = async (
    r: Reservation,
    via: "kakao" | "sms",
    kind: "confirm" | "reminder",
    silent = false
  ): Promise<boolean> => {
    if (!r.customerPhone) {
      if (!silent) showToast(t("resMsg.toast.noPhone", lang), "error");
      return false;
    }
    const fmtDate = new Date(r.date).toLocaleDateString(locale, {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    const titleKey = kind === "confirm" ? "resMsg.confirm.title" : "resMsg.reminder.title";
    const bodyKey = kind === "confirm" ? "resMsg.confirm.body" : "resMsg.reminder.body";
    const title = t(titleKey, lang, { store: storeName });
    const body = t(bodyKey, lang, {
      name: r.customerName,
      date: fmtDate,
      time: r.time,
      party: r.partySize,
    });

    if (via === "kakao") {
      const res = await sendKakaoMessage(body, title, storeId ?? "");
      if (res.ok) {
        if (!silent) showToast(t("resMsg.toast.kakaoOk", lang), "success");
        return true;
      }
      if (!silent) showToast(t("resMsg.toast.kakaoFail", lang, { msg: res.message ?? "" }), "error");
      return false;
    }
    // SMS — 모바일에서 sms: 딥링크, PC면 차단됨
    const res = await sendPhysicalSms(r.customerPhone, `${title}\n${body}`, "device");
    if (res.ok) {
      if (!silent) showToast(t("resMsg.toast.smsOk", lang), "success");
      return true;
    }
    if (!silent) showToast(t("resMsg.toast.smsFail", lang, { msg: res.message ?? "" }), "error");
    return false;
  };

  // 로컬 자정 기준 'YYYY-MM-DD' — toISOString() 은 UTC 라 KST 외 매장에서 어긋남.
  const localISO = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // 내일 예약 일괄 리마인더 — 중복 클릭 가드 포함
  const [reminderBusy, setReminderBusy] = useState(false);
  const sendTomorrowReminders = async (via: "kakao" | "sms") => {
    if (reminderBusy) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localISO(tomorrow);
    const targets = reservations.filter(
      (r) => r.storeId === storeId && r.date === tomorrowStr && r.status === "confirmed" && r.customerPhone
    );
    if (targets.length === 0) {
      showToast(t("resMsg.toast.noTomorrow", lang), "info");
      return;
    }
    setReminderBusy(true);
    try {
      let sent = 0;
      let failed = 0;
      for (const r of targets) {
        // SMS는 sms: 딥링크라 연속 호출이 깨짐 — 카톡만 일괄 가능
        // SMS의 경우 첫 1건만 발송하고 나머지는 사장님이 수동 진행 (모바일 UX 한계)
        if (via === "sms" && sent + failed >= 1) break;
        // silent=true 로 카드별 토스트 생략, 마지막에 1개만 — 토스트 폭격 차단.
        // 실제 성공한 건만 sent 카운트 — 기존엔 실패도 sent++ 되어 사장님이
        // 잘못된 "n명 보냈어요" 토스트 보고 안 보낸 손님을 또 안 보내던 버그.
        // eslint-disable-next-line no-await-in-loop
        const ok = await sendMessage(r, via, "reminder", true);
        if (ok) sent++;
        else failed++;
      }
      if (sent > 0) {
        showToast(t("resMsg.toast.batchDone", lang, { n: sent }), "success");
      }
      if (failed > 0) {
        showToast(t("resMsg.toast.batchFailed", lang, { n: failed }), "error");
      }
    } finally {
      setReminderBusy(false);
    }
  };

  // 내일 예약 카운트
  const tomorrowReservationsCount = useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = localISO(tomorrow);
    return reservations.filter(
      (r) => r.storeId === storeId && r.date === tomorrowStr && r.status === "confirmed" && r.customerPhone
    ).length;
  }, [reservations, storeId]);

  // 본 매장 단골 (visits 있는 고객) — 검색 후보 1순위
  const myCustomers = useMemo(() => {
    const visited = new Set(visits.filter((v) => v.storeId === storeId).map((v) => v.customerId));
    return users.filter(
      (u) => u.role === "customer" && u.status !== "deleted" && visited.has(u.id)
    );
  }, [users, visits, storeId]);

  // 본 매장에 예약 이력 있는 손님 (단골은 아니지만 예약은 함) — 2순위
  const reservedNames = useMemo(() => {
    const seen = new Map<string, { name: string; phone: string }>();
    reservations
      .filter((r) => r.storeId === storeId)
      .forEach((r) => {
        const key = digitsOnly(r.customerPhone) || r.customerName;
        if (!seen.has(key)) seen.set(key, { name: r.customerName, phone: r.customerPhone });
      });
    return Array.from(seen.values());
  }, [reservations, storeId]);
  const [filter, setFilter] = useState<"upcoming" | "all">("upcoming");
  const [view, setView] = useState<"list" | "calendar">("list");
  // 캘린더가 보고 있는 달의 첫째 날(1일). null 이면 오늘 기준.
  const [calMonth, setCalMonth] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // 캘린더에서 날짜 클릭 시 그 날만 보여주는 모드
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // 작성 중 내용이 있으면 ESC/백드롭 닫기 전 confirm — 입력 손실 방지
  const closeDraft = () => {
    if (!draft) return;
    const hasContent = !!(
      draft.customerName.trim() ||
      draft.customerPhone.trim() ||
      draft.memo.trim() ||
      draft.customerId
    );
    if (hasContent && !confirm(t("ores.discardConfirm", lang))) return;
    setDraft(null);
  };
  useEscapeClose(!!draft, closeDraft);
  useModalChrome(!!draft);

  const list = useMemo(() => {
    const all = reservations.filter((r) => r.storeId === storeId);
    // 캘린더에서 특정 날짜를 선택했으면 그 날만
    if (selectedDate) {
      return all
        .filter((r) => r.date === selectedDate)
        .sort((a, b) => a.time.localeCompare(b.time));
    }
    if (filter === "upcoming") {
      const today = todayStr();
      return all
        .filter((r) => r.date >= today && r.status === "confirmed")
        .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
    }
    return all.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }, [reservations, storeId, filter, selectedDate]);

  // 달력 셀별 예약 묶음 — 한 번만 계산해 캘린더 렌더에 재사용
  const reservationsByDate = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations) {
      if (r.storeId !== storeId) continue;
      const arr = map.get(r.date) ?? [];
      arr.push(r);
      map.set(r.date, arr);
    }
    // 시간순 정렬
    for (const arr of map.values()) arr.sort((a, b) => a.time.localeCompare(b.time));
    return map;
  }, [reservations, storeId]);

  const grouped = useMemo(() => {
    const map: Record<string, Reservation[]> = {};
    for (const r of list) (map[r.date] ??= []).push(r);
    return map;
  }, [list]);

  const save = async () => {
    if (!draft) return;
    if (!draft.customerName.trim() || !draft.customerPhone.trim()) {
      showToast(t("ores.err.required", lang), "error");
      return;
    }
    if (!storeId) {
      showToast(t("ores.err.noStore", lang), "error");
      return;
    }
    // 과거 날짜·시간 경고 (신규일 때만)
    if (!draft.id) {
      const scheduled = new Date(`${draft.date}T${draft.time || "00:00"}`);
      if (scheduled.getTime() < Date.now() - 60_000) {
        if (!confirm(t("ores.err.pastDate", lang))) return;
      }
    }
    const tableNumber = Number(draft.tableNumber) || 1;
    // 같은 매장·날짜·시간·테이블에 이미 확정 예약이 있으면 차단 (수정 중인 자신은 제외)
    const dup = reservations.find(
      (r) =>
        r.storeId === storeId &&
        r.id !== draft.id &&
        r.date === draft.date &&
        r.time === draft.time &&
        r.tableNumber === tableNumber &&
        r.status === "confirmed"
    );
    if (dup) {
      showToast(t("ores.err.duplicate", lang, { date: draft.date, time: draft.time, n: tableNumber }), "error");
      return;
    }
    const data = {
      storeId,
      date: draft.date,
      time: draft.time,
      tableNumber,
      partySize: Number(draft.partySize) || 1,
      customerName: draft.customerName.trim(),
      customerPhone: draft.customerPhone.trim(),
      memo: draft.memo || undefined,
    };
    try {
      if (draft.id) {
        await updateReservation(draft.id, data);
        showToast(t("ores.ok.updated", lang), "success");
      } else {
        await addReservation(data);
        showToast(t("ores.ok.added", lang), "success");
      }
      setDraft(null);
    } catch (e: any) {
      showToast(t("ores.err.saveFail", lang, { msg: e?.message ?? "" }), "error");
    }
  };

  return (
    <OwnerShell
      title={t("ores.title", lang)}
      headerRight={
        <div className="flex items-center gap-2">
          {tomorrowReservationsCount > 0 && (
            <button
              onClick={() => sendTomorrowReminders("kakao")}
              disabled={reminderBusy}
              className="h-10 px-3.5 rounded-full bg-[#FEE500] text-[#191919] inline-flex items-center gap-1.5 text-[12.5px] font-extrabold disabled:opacity-50"
              title={t("resMsg.btn.reminderAll", lang, { n: tomorrowReservationsCount })}
            >
              <Bell className="w-4 h-4" />
              <span className="hidden sm:inline">{t("resMsg.btn.reminderAll", lang, { n: tomorrowReservationsCount })}</span>
              <span className="sm:hidden tabular-nums">{tomorrowReservationsCount}</span>
            </button>
          )}
          <button
            onClick={() =>
              window.open(
                "/biz/owner/welcome-display",
                "gyeol-welcome-display",
                "popup=yes,width=1280,height=800"
              )
            }
            className="h-10 px-3 sm:px-3.5 rounded-full bg-white border border-[var(--color-line)] text-[var(--color-navy-700)] inline-flex items-center gap-1.5 text-[13px] font-bold shrink-0"
            title={t("ores.openDisplayTip", lang)}
            aria-label={t("ores.openDisplay", lang)}
          >
            <Monitor className="w-4 h-4" />
            <span className="hidden sm:inline">{t("ores.openDisplay", lang)}</span>
          </button>
          <button
            onClick={() => setDraft(newDraft())}
            className="h-10 px-3 sm:px-4 rounded-full bg-[var(--color-navy-700)] text-white inline-flex items-center gap-1.5 text-[13px] font-bold shadow-[var(--shadow-navy)] shrink-0"
            aria-label={t("ores.newBtn", lang)}
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">{t("ores.newBtn", lang)}</span>
          </button>
        </div>
      }
    >
      <div className="max-w-[900px] mx-auto">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          {/* List / Calendar 뷰 토글 */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-white border border-[var(--color-line)] rounded-[14px]">
            {(["list", "calendar"] as const).map((v) => (
              <button
                key={v}
                onClick={() => { setView(v); setSelectedDate(null); }}
                className={`h-10 px-3.5 rounded-[10px] text-[12px] font-bold inline-flex items-center gap-1.5 ${
                  view === v ? "bg-[var(--color-navy-700)] text-white" : "text-[var(--color-ink-500)]"
                }`}
              >
                {v === "list" ? <ListIcon className="w-3.5 h-3.5" /> : <CalendarDays className="w-3.5 h-3.5" />}
                {v === "list" ? t("ores.view.list", lang) : t("ores.view.calendar", lang)}
              </button>
            ))}
          </div>
          {/* 리스트 뷰에서만 upcoming/all 필터 노출 */}
          {view === "list" && !selectedDate && (
            <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--color-navy-50)] rounded-[14px]">
              {(["upcoming", "all"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`h-10 px-3.5 rounded-[10px] text-[12px] font-bold ${
                    filter === f ? "bg-white text-[var(--color-navy-800)]" : "text-[var(--color-ink-500)]"
                  }`}
                >
                  {f === "upcoming" ? t("ores.filter.upcoming", lang) : t("ores.filter.all", lang)}
                </button>
              ))}
            </div>
          )}
          {/* 선택된 날짜가 있으면 칩으로 표시 + 해제 */}
          {selectedDate && (
            <div className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-full bg-[var(--color-mint-100)] text-[var(--color-mint-700)] text-[12.5px] font-bold">
              {new Date(selectedDate).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" })}
              <button
                onClick={() => setSelectedDate(null)}
                className="w-5 h-5 rounded-full hover:bg-white/60 inline-flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Calendar 뷰 */}
        {view === "calendar" && (
          <MonthCalendar
            month={calMonth}
            onPrev={() => setCalMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}
            onNext={() => setCalMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}
            onToday={() => {
              const now = new Date();
              setCalMonth(new Date(now.getFullYear(), now.getMonth(), 1));
              setSelectedDate(localTodayStr(now));
            }}
            reservationsByDate={reservationsByDate}
            onDayClick={(dateStr) => setSelectedDate(dateStr)}
            selectedDate={selectedDate}
            locale={locale}
          />
        )}

        {Object.keys(grouped).length === 0 ? (
          <Card padding="lg" className="text-center text-[14px] text-[var(--color-ink-500)] mt-4">
            {t("ores.empty", lang)}
          </Card>
        ) : (
          Object.entries(grouped).map(([date, items]) => (
            <div key={date} className="mt-4">
              <h3 className="text-[14px] font-bold text-[var(--color-ink-700)] px-1 mb-2">
                {new Date(date).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" })}
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {items.map((r) => (
                  <Card key={r.id} padding="md">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[15px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                        {r.time}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_COLORS[r.status]}`}>
                        {t(STATUS_KEYS[r.status], lang)}
                      </span>
                      <button
                        onClick={() => {
                          if (confirm(t("ores.deleteConfirm", lang, { name: r.customerName }))) {
                            deleteReservation(r.id);
                          }
                        }}
                        className="ml-auto w-8 h-8 rounded-full hover:bg-[var(--color-danger)]/10 inline-flex items-center justify-center text-[var(--color-danger)]"
                        aria-label={t("ores.deleteAria", lang)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[13px] font-semibold text-[var(--color-navy-900)]">
                      {t("ores.partyAndTable", lang, { name: r.customerName, n: r.partySize, table: r.tableNumber })}
                    </div>
                    <div className="text-[12px] text-[var(--color-ink-500)] flex items-center gap-1 mt-0.5">
                      <Phone className="w-3 h-3" />
                      {r.customerPhone}
                    </div>
                    {r.memo && (
                      <p className="text-[13px] text-[var(--color-ink-600)] mt-1.5 bg-[var(--color-bg)] px-2 py-1.5 rounded break-keep">
                        {r.memo}
                      </p>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2.5">
                      {(["confirmed", "completed", "no-show", "cancelled"] as ReservationStatus[]).map((s) => (
                        <button
                          key={s}
                          onClick={() => updateReservation(r.id, { status: s })}
                          className={`h-10 rounded-lg text-[12px] font-bold transition-colors ${
                            r.status === s
                              ? "bg-[var(--color-navy-700)] text-white"
                              : "bg-[var(--color-bg)] text-[var(--color-ink-600)] hover:bg-[var(--color-navy-50)]"
                          }`}
                        >
                          {t(STATUS_KEYS[s], lang)}
                        </button>
                      ))}
                    </div>
                    {/* 확정 상태일 때만 메시지 버튼 노출. 카톡/SMS — 확인 메시지는 클릭 시점 자동 분기:
                        오늘 이전 = 확인, 그 외(미래) = 확인. 리마인더는 일괄 버튼이 따로 있음. */}
                    {r.status === "confirmed" && r.customerPhone && (
                      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                        <button
                          onClick={() => sendMessage(r, "kakao", "confirm")}
                          className="h-9 rounded-lg bg-[#FEE500] text-[#191919] inline-flex items-center justify-center gap-1 text-[12px] font-extrabold"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          {t("resMsg.btn.kakao", lang)}
                        </button>
                        <button
                          onClick={() => sendMessage(r, "sms", "confirm")}
                          className="h-9 rounded-lg bg-white border border-[var(--color-line)] text-[var(--color-navy-800)] inline-flex items-center justify-center gap-1 text-[12px] font-bold hover:bg-[var(--color-navy-50)]"
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                          {t("resMsg.btn.sms", lang)}
                        </button>
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={closeDraft}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-6 pb-[max(env(safe-area-inset-bottom),24px)] sm:pb-6 max-h-[88vh] overflow-y-auto"
          >
            <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-5" />
            <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)] mb-4">
              {draft.id ? t("ores.editTitle", lang) : t("ores.newTitle", lang)}
            </h2>
            <div className="space-y-3">
              {/* 고객 선택/검색 — 등록 고객이면 자동 채움, 없으면 게스트 */}
              <CustomerPicker
                value={{
                  customerName: draft.customerName,
                  customerPhone: draft.customerPhone,
                  customerId: draft.customerId,
                  isGuest: !!draft.isGuest,
                }}
                onChange={(v) => setDraft({ ...draft, ...v })}
                customers={myCustomers}
                previousGuests={reservedNames}
              />

              {/* 전화번호 — 단골 선택 시 자동 채워짐, 게스트면 직접 입력 */}
              <Input
                label={t("ores.field.phone", lang)}
                value={draft.customerPhone}
                onChange={(e) => setDraft({ ...draft, customerPhone: formatPhoneNumber(e.target.value), customerId: undefined })}
                inputMode="numeric"
                placeholder="010-0000-0000"
              />

              <div className="grid grid-cols-2 gap-3">
                <Input label={t("ores.field.date", lang)} type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                <Input label={t("ores.field.time", lang)} type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
              </div>

              {/* 테이블 + 인원 (스테퍼 UI) */}
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t("ores.field.table", lang)}
                  inputMode="numeric"
                  value={draft.tableNumber}
                  onChange={(e) => setDraft({ ...draft, tableNumber: e.target.value.replace(/\D/g, "") })}
                />
                <PartyStepper
                  value={Number(draft.partySize) || 1}
                  onChange={(n) => setDraft({ ...draft, partySize: String(Math.max(1, Math.min(99, n))) })}
                />
              </div>

              <Input label={t("ores.field.memo", lang)} value={draft.memo} onChange={(e) => setDraft({ ...draft, memo: e.target.value })} />
            </div>
            <Button block className="mt-5" onClick={save}>{t("omenus.save", lang)}</Button>
          </div>
        </div>
      )}
    </OwnerShell>
  );
}

// ============================================================
// CustomerPicker — 등록 고객 검색·선택 + 게스트 입력 폴백

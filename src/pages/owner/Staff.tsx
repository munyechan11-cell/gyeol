import { useMemo, useState } from "react";
import { Check, X, UserMinus, Clock, ChevronDown, ChevronUp, UserCheck, UserPlus, Shield, KeyRound } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { useStore } from "../../store/store";
import { STAFF_LEVELS, STAFF_LEVEL_KEY, STAFF_FEATURES, PERM_MANAGE_STAFF, canStaffAccess } from "../../lib/staffAccess";
import { formatPhoneNumber } from "../../lib/ids";
import { useLanguage, t, type Lang, getLocale, fmtKRW } from "../../lib/i18n";
import { resetPasswordFor } from "../../lib/phoneAuth";
import { showToast } from "../../lib/toast";

function fmtDuration(ms: number, lang: Lang) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return t("ostaff.hourMin", lang, { h, m });
}

function fmtDate(iso: string, lang: Lang) {
  const d = new Date(iso);
  const locale = getLocale(lang);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export default function OwnerStaff() {
  const { currentUser, effectiveStoreId, users, shifts, approveStaff, rejectStaff, removeStaffMembership, setStaffWage, setStaffLevel, setStaffPerms } = useStore();
  const lang = useLanguage();
  const locale = getLocale(lang);
  const [openShiftsFor, setOpenShiftsFor] = useState<string | null>(null);
  const [openPermsFor, setOpenPermsFor] = useState<string | null>(null);
  const [wageEdit, setWageEdit] = useState<Record<string, string>>({});

  // 사장=본인, lv4(실장) 직원=소속 매장. 직원 본인 id 로 필터하면 직원 목록·근무기록이 비어 보인다.
  const storeId = effectiveStoreId;
  const isOwner = currentUser?.role === "owner";
  // 등급 조정 능력 = 사장 기본, 또는 사장이 위임(PERM_MANAGE_STAFF)한 직원. 권한 부여(extraPerms)·재위임은 사장 전용.
  const canManageStaff = isOwner || (currentUser?.extraPerms?.includes(PERM_MANAGE_STAFF) ?? false);
  // 위임받은 직원이 '자기 자신'의 등급을 올리는 셀프 권한상승은 항상 차단.
  const canEditLevelOf = (targetId: string) => canManageStaff && (isOwner || targetId !== currentUser?.id);

  const myStaff = useMemo(
    () => users.filter((u) => u.role === "staff" && u.employerStoreId === storeId),
    [users, storeId]
  );
  const pending = myStaff.filter((s) => s.employerStatus === "pending");
  const approved = myStaff.filter((s) => s.employerStatus === "approved");

  const statsByStaff = useMemo(() => {
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const map = new Map<string, { todayMs: number; weekMs: number; monthMs: number; onDuty: boolean; activeSince?: string }>();
    const todayKey = new Date().toDateString();
    const thisMonth = `${new Date().getFullYear()}-${new Date().getMonth()}`;
    for (const s of shifts.filter((s) => s.storeId === storeId)) {
      const inDate = new Date(s.clockInAt);
      const inT = inDate.getTime();
      const outT = s.clockOutAt ? new Date(s.clockOutAt).getTime() : now;
      const dur = Math.max(0, outT - inT);
      const cur = map.get(s.staffId) ?? { todayMs: 0, weekMs: 0, monthMs: 0, onDuty: false };
      if (inDate.toDateString() === todayKey) cur.todayMs += dur;
      if (inT >= weekAgo) cur.weekMs += dur;
      if (`${inDate.getFullYear()}-${inDate.getMonth()}` === thisMonth) cur.monthMs += dur;
      if (!s.clockOutAt) {
        cur.onDuty = true;
        cur.activeSince = s.clockInAt;
      }
      map.set(s.staffId, cur);
    }
    return map;
  }, [shifts, storeId]);

  return (
    <OwnerShell title={t("ostaff.title", lang)}>
      {/* 대기 요청 */}
      <section className="mb-7">
        <h2 className="headline-sub mb-3 px-1 flex items-center gap-2">
          <UserPlus className="w-4 h-4" />
          {t("ostaff.pending.title", lang, { n: pending.length })}
        </h2>
        {pending.length === 0 ? (
          <Card padding="lg" className="text-center body-sm">
            {t("ostaff.pending.empty", lang)}
          </Card>
        ) : (
          <div className="space-y-2">
            {pending.map((s) => (
              <Card key={s.id} padding="md" className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-bold text-[var(--color-navy-900)] break-keep">
                    {s.name} {s.position && <span className="text-[var(--color-navy-700)] font-bold">· {s.position}</span>}
                  </p>
                  <p className="body-sm">{formatPhoneNumber(s.phone)}</p>
                  {s.joinRequestedAt && (
                    <p className="text-[12px] text-[var(--color-ink-600)] font-semibold mt-0.5">
                      {t("ostaff.requestedAt", lang, { when: fmtDate(s.joinRequestedAt, lang) })}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 ml-auto">
                  <Button size="sm" leftIcon={<Check className="w-4 h-4" />} onClick={() => approveStaff(s.id)}>
                    {t("ostaff.approve", lang)}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<X className="w-4 h-4" />}
                    onClick={() => rejectStaff(s.id)}
                  >
                    {t("ostaff.reject", lang)}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* 활성 직원 */}
      <section>
        <h2 className="headline-sub mb-3 px-1 flex items-center gap-2">
          <UserCheck className="w-4 h-4" />
          {t("ostaff.active.title", lang, { n: approved.length })}
        </h2>
        {approved.length === 0 ? (
          <Card padding="lg" className="text-center body-sm">
            {t("ostaff.active.empty", lang)}
          </Card>
        ) : (
          <div className="space-y-2">
            {approved.map((s) => {
              const st = statsByStaff.get(s.id) ?? { todayMs: 0, weekMs: 0, monthMs: 0, onDuty: false };
              const open = openShiftsFor === s.id;
              const permsOpen = openPermsFor === s.id;
              const myShifts = shifts
                .filter((sh) => sh.storeId === storeId && sh.staffId === s.id)
                .sort((a, b) => b.clockInAt.localeCompare(a.clockInAt))
                .slice(0, 30);
              return (
                <Card key={s.id} padding="md">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <p className="text-[15px] font-bold text-[var(--color-navy-900)] truncate flex items-center gap-2">
                        {s.name}
                        {st.onDuty && (
                          <span className="chip text-[11px] bg-[var(--color-mint-100)] text-[var(--color-mint-700)] px-2 py-0.5">
                            {t("ostaff.onDuty", lang)}
                          </span>
                        )}
                      </p>
                      <p className="body-sm">
                        {formatPhoneNumber(s.phone)}
                        {s.position ? ` · ${s.position}` : ""}
                      </p>
                      <p className="text-[12px] text-[var(--color-ink-600)] font-semibold mt-1 flex items-center gap-3 flex-wrap">
                        <span><Clock className="inline w-3 h-3 mr-1" />{t("ostaff.today", lang, { dur: fmtDuration(st.todayMs, lang) })}</span>
                        <span>{t("ostaff.thisWeek", lang, { dur: fmtDuration(st.weekMs, lang) })}</span>
                        {st.activeSince && (
                          <span>{t("ostaff.clockedInAt", lang, { time: new Date(st.activeSince).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</span>
                        )}
                      </p>
                      <div className="text-[12px] mt-1.5 flex items-center gap-2 flex-wrap">
                        <span className="text-[var(--color-ink-600)] font-semibold">
                          {t("ostaff.thisMonth", lang, { dur: fmtDuration(st.monthMs, lang) })}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <span className="text-[var(--color-ink-500)]">{t("ostaff.wage", lang)}</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={wageEdit[s.id] ?? String(s.hourlyWage ?? "")}
                            onChange={(e) => setWageEdit((w) => ({ ...w, [s.id]: e.target.value.replace(/\D/g, "") }))}
                            onBlur={(e) => {
                              const v = Number(e.target.value) || 0;
                              if (v !== (s.hourlyWage ?? 0)) setStaffWage(s.id, v);
                            }}
                            className="w-20 h-8 px-2 rounded-lg border border-[var(--color-line)] text-[12px] tabular-nums text-right"
                            placeholder="0"
                          />
                        </span>
                        <span className="font-extrabold text-[var(--color-navy-700)] tabular-nums">
                          {t("ostaff.monthPay", lang, {
                            amount: fmtKRW(Math.round((st.monthMs / 3600000) * (Number(wageEdit[s.id] ?? s.hourlyWage) || 0))),
                          })}
                        </span>
                      </div>
                      {/* 권한 등급 — 사장님이 직원 등급 지정. 등급↑ → 접근 범위 누적 */}
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-[11.5px] text-[var(--color-ink-500)] font-bold">{t("ostaff.level", lang)}</span>
                        {canEditLevelOf(s.id) ? (
                          // 등급 변경 = 사장 또는 위임받은 직원. 단 위임 직원은 자기 자신 행을 못 바꿈(셀프 권한상승 차단).
                          <div role="group" aria-label={t("ostaff.level", lang)} className="inline-flex gap-0.5 p-0.5 bg-[var(--color-navy-50)] rounded-lg">
                            {STAFF_LEVELS.map((lv) => (
                              <button
                                key={lv}
                                onClick={() => setStaffLevel(s.id, lv)}
                                aria-pressed={(s.staffLevel ?? 1) === lv}
                                className={`h-7 px-2.5 rounded-md text-[11.5px] font-bold transition-colors ${
                                  (s.staffLevel ?? 1) === lv
                                    ? "bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]"
                                    : "text-[var(--color-ink-500)]"
                                }`}
                              >
                                {t(`staffLevel.${STAFF_LEVEL_KEY[lv]}`, lang)}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <span className="h-7 px-2.5 inline-flex items-center rounded-md text-[11.5px] font-bold bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]">
                            {t(`staffLevel.${STAFF_LEVEL_KEY[s.staffLevel ?? 1]}`, lang)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 ml-auto">
                      {isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<Shield className="w-4 h-4" />}
                          onClick={() => setOpenPermsFor(permsOpen ? null : s.id)}
                        >
                          {t("ostaff.perms", lang)}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        rightIcon={open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        onClick={() => setOpenShiftsFor(open ? null : s.id)}
                      >
                        {t("ostaff.shifts", lang)}
                      </Button>
                      {/* 직원이 비밀번호를 잊으면 스스로 되찾을 길이 없다(문자 발송 없음).
                          사장님이 대신 바꿔 준다. 서버가 "내 매장 직원인지"를 다시 확인한다. */}
                      {isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          leftIcon={<KeyRound className="w-4 h-4" />}
                          onClick={async () => {
                            const pw = prompt(t("auth.phone.resetPrompt", lang, { name: s.name }));
                            if (!pw) return;
                            try {
                              await resetPasswordFor(s.id, pw);
                              showToast(t("auth.phone.resetDone", lang), "success");
                            } catch (e: any) {
                              showToast(e?.message ?? t("auth.phone.resetFailed", lang), "error");
                            }
                          }}
                        >
                          {t("auth.phone.resetBtn", lang)}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        leftIcon={<UserMinus className="w-4 h-4" />}
                        onClick={() => {
                          if (confirm(t("ostaff.removeConfirm", lang, { name: s.name }))) removeStaffMembership(s.id);
                        }}
                      >
                        {t("ostaff.remove", lang)}
                      </Button>
                    </div>
                  </div>

                  {permsOpen && (
                    <div className="mt-3 pt-3 border-t border-[var(--color-line-soft)]">
                      <p className="text-[12px] font-bold text-[var(--color-ink-600)] mb-2">{t("ostaff.perms.title", lang)}</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {STAFF_FEATURES.map((f) => {
                          const lvl = s.staffLevel ?? 1;
                          const byLevel = lvl >= f.minLevel;
                          const extra = s.extraPerms ?? [];
                          const granted = byLevel || extra.includes(f.path);
                          return (
                            <button
                              key={f.path}
                              disabled={byLevel}
                              onClick={() => {
                                const next = extra.includes(f.path)
                                  ? extra.filter((p) => p !== f.path)
                                  : [...extra, f.path];
                                setStaffPerms(s.id, next);
                              }}
                              className={`flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-[12px] font-semibold text-left transition-colors ${
                                granted ? "bg-[var(--color-mint-50)] text-[var(--color-navy-800)]" : "bg-[var(--color-bg)] text-[var(--color-ink-500)]"
                              } ${byLevel ? "opacity-70 cursor-default" : ""}`}
                            >
                              {granted ? <Check className="w-3.5 h-3.5 shrink-0 text-[var(--color-mint-700)]" /> : <span className="w-3.5 shrink-0" />}
                              <span className="truncate flex-1">{t(f.labelKey, lang)}</span>
                              {byLevel && <span className="text-[9px] text-[var(--color-ink-400)] shrink-0">{t("ostaff.perms.byLevel", lang)}</span>}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-[var(--color-ink-500)] mt-2 leading-relaxed">{t("ostaff.perms.hint", lang)}</p>

                      {/* 직원 권한 관리 위임 — 직원관리 화면에 접근 가능한 직원에게만 의미. 켜면 그 직원이 다른 직원 등급을 조정 가능. */}
                      {canStaffAccess("/biz/owner/staff", s.staffLevel ?? 1, s.extraPerms) && (() => {
                        const extra = s.extraPerms ?? [];
                        const delegated = extra.includes(PERM_MANAGE_STAFF);
                        return (
                          <div className="mt-3 pt-3 border-t border-[var(--color-line-soft)]">
                            <button
                              onClick={() =>
                                setStaffPerms(
                                  s.id,
                                  delegated ? extra.filter((p) => p !== PERM_MANAGE_STAFF) : [...extra, PERM_MANAGE_STAFF]
                                )
                              }
                              aria-pressed={delegated}
                              className={`flex items-center gap-1.5 w-full h-10 px-2.5 rounded-lg text-[12px] font-bold text-left transition-colors ${
                                delegated ? "bg-[var(--color-mint-50)] text-[var(--color-navy-800)]" : "bg-[var(--color-bg)] text-[var(--color-ink-500)]"
                              }`}
                            >
                              {delegated ? <Check className="w-3.5 h-3.5 shrink-0 text-[var(--color-mint-700)]" /> : <Shield className="w-3.5 h-3.5 shrink-0" />}
                              <span className="flex-1">{t("ostaff.perms.manageStaff", lang)}</span>
                            </button>
                            <p className="text-[11px] text-[var(--color-ink-500)] mt-1.5 leading-relaxed">{t("ostaff.perms.manageStaffHint", lang)}</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  {open && (
                    <div className="mt-3 pt-3 border-t border-[var(--color-line-soft)] space-y-1">
                      {myShifts.length === 0 ? (
                        <p className="body-sm text-center text-[var(--color-ink-500)] py-2">
                          {t("ostaff.noRecord", lang)}
                        </p>
                      ) : (
                        myShifts.map((sh) => {
                          const inT = new Date(sh.clockInAt).getTime();
                          const outT = sh.clockOutAt ? new Date(sh.clockOutAt).getTime() : Date.now();
                          return (
                            <div
                              key={sh.id}
                              className="flex items-center justify-between text-[12px] text-[var(--color-ink-700)] font-semibold py-1"
                            >
                              <span>{fmtDate(sh.clockInAt, lang)} → {sh.clockOutAt ? fmtDate(sh.clockOutAt, lang) : t("ostaff.workingNow", lang)}</span>
                              <span className="tabular-nums text-[var(--color-navy-700)]">
                                {fmtDuration(outT - inT, lang)}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </OwnerShell>
  );
}

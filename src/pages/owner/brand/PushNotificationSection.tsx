import { Sec, ToggleSwitch } from "./controls";
import { useEffect, useState } from "react";
import { Info, CheckCircle2, AlertCircle, Bell, BellOff, Smartphone } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import { Button } from "../../../components/ui/Button";
import { showToast } from "../../../lib/toast";
import { isPushSupported, getPermissionState, registerOwnerDevice, unregisterOwnerDevice, type PermissionState } from "../../../lib/pushNotifications";

// ============================================================
export function PushNotificationSection({
  storeId,
  prefs,
  deviceCount,
  onPrefChange,
}: {
  storeId: string;
  prefs?: { newOrder?: boolean; paymentRequest?: boolean; staffJoin?: boolean; couponRequest?: boolean };
  deviceCount: number;
  onPrefChange: (patch: NonNullable<typeof prefs>) => Promise<void>;
}) {
  const lang = useLanguage();
  const [supported, setSupported] = useState<boolean | null>(null);
  const [perm, setPerm] = useState<PermissionState>("default");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(deviceCount > 0);

  useEffect(() => {
    let alive = true;
    (async () => {
      const ok = await isPushSupported();
      const p = await getPermissionState();
      if (!alive) return;
      setSupported(ok);
      setPerm(p);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { setRegistered(deviceCount > 0); }, [deviceCount]);

  const [lastErrorDetail, setLastErrorDetail] = useState<string>("");
  const [lastErrorReason, setLastErrorReason] = useState<string>("");

  const enable = async () => {
    setBusy(true);
    setLastErrorDetail("");
    setLastErrorReason("");
    try {
      const r = await registerOwnerDevice(storeId);
      if (r.ok) {
        setRegistered(true);
        setPerm("granted");
        showToast(t("obsPush.toast.on", lang), "success");
        return;
      }
      // 실패 — reason 별 친화 메시지 + 상세 에러 카드
      setLastErrorReason(r.reason ?? "error");
      setLastErrorDetail(r.detail ?? "");
      switch (r.reason) {
        case "unsupported":
          showToast(t("obsPush.toast.unsupported", lang), "info");
          break;
        case "denied":
          showToast(t("obsPush.toast.denied", lang), "error");
          setPerm("denied");
          break;
        case "no-vapid":
          showToast(t("obsPush.toast.noVapid", lang), "error");
          break;
        case "sw-register-failed":
          showToast(t("obsPush.toast.swFail", lang), "error");
          break;
        case "no-auth":
          showToast(t("obsPush.toast.noAuth", lang), "error");
          break;
        case "firestore-error":
          showToast(t("obsPush.toast.firestore", lang, { detail: r.detail ?? "" }).slice(0, 100), "error");
          break;
        default:
          showToast(t("obsPush.toast.fail", lang, { detail: r.detail ?? t("obsPush.toast.reasonUnknown", lang) }), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await unregisterOwnerDevice(storeId);
      setRegistered(false);
      showToast(t("obsPush.toast.off", lang), "info");
    } finally {
      setBusy(false);
    }
  };

  const isOn = perm === "granted" && registered;

  return (
    <Sec title={t("obsPush.title", lang)}>
      <div className="space-y-3">
        {/* 상태 카드 */}
        {supported === false ? (
          <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[#fef2f2] border border-[var(--color-danger)]/30">
            <AlertCircle className="w-4 h-4 text-[var(--color-danger)] mt-0.5 shrink-0" />
            <p className="text-[12px] text-[var(--color-danger)] font-semibold leading-relaxed">
              {t("obsPush.unsupported", lang)}
              <br />
              <span className="font-medium opacity-90">
                {t("obsPush.unsupportedDesc", lang)}
              </span>
            </p>
          </div>
        ) : perm === "denied" ? (
          <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[#fff8e6] border border-[#f0b400]/40">
            <AlertCircle className="w-4 h-4 text-[#b07b00] mt-0.5 shrink-0" />
            <p className="text-[12px] text-[#b07b00] font-semibold leading-relaxed">
              {t("obsPush.denied", lang)}
            </p>
          </div>
        ) : (
          <div className={`flex items-start gap-2 p-3.5 rounded-[14px] ${
            isOn
              ? "bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]"
              : "bg-[var(--color-navy-50)] border border-[var(--color-navy-200)]"
          }`}>
            {isOn ? (
              <CheckCircle2 className="w-4 h-4 text-[var(--color-mint-700)] mt-0.5 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-[var(--color-navy-700)] mt-0.5 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className={`text-[13px] font-bold ${isOn ? "text-[var(--color-mint-700)]" : "text-[var(--color-navy-700)]"}`}>
                {isOn ? t("obsPush.onTitle", lang, { n: deviceCount }) : t("obsPush.offTitle", lang)}
              </p>
              <p className={`text-[11.5px] font-medium opacity-90 mt-0.5 ${isOn ? "text-[var(--color-mint-700)]" : "text-[var(--color-navy-700)]"}`}>
                {isOn ? t("obsPush.onDesc", lang) : t("obsPush.offDesc", lang)}
              </p>
            </div>
          </div>
        )}

        {/* 실패 진단 카드 — reason 별 해결법 */}
        {lastErrorReason && !isOn && (
          <div className="p-3.5 rounded-[14px] bg-[#fef2f2] border border-[var(--color-danger)]/40">
            <p className="text-[12.5px] font-extrabold text-[var(--color-danger)] mb-1">
              {t("obsPush.failTitle", lang, { reason:
                ({
                  "no-vapid": t("obsPush.reason.noVapid", lang),
                  "sw-register-failed": t("obsPush.reason.swFail", lang),
                  "denied": t("obsPush.reason.denied", lang),
                  "no-auth": t("obsPush.reason.noAuth", lang),
                  "firestore-error": t("obsPush.reason.firestore", lang),
                  "unsupported": t("obsPush.reason.unsupported", lang),
                  "error": t("obsPush.reason.error", lang),
                } as Record<string, string>)[lastErrorReason] || lastErrorReason
              })}
            </p>
            <p className="text-[11.5px] text-[var(--color-ink-700)] leading-relaxed font-medium">
              {({
                "no-vapid": t("obsPush.help.noVapid", lang),
                "sw-register-failed": t("obsPush.help.swFail", lang),
                "denied": t("obsPush.help.denied", lang),
                "no-auth": t("obsPush.help.noAuth", lang),
                "firestore-error": t("obsPush.help.firestore", lang),
                "unsupported": t("obsPush.help.unsupported", lang),
              } as Record<string, string>)[lastErrorReason] || t("obsPush.help.fallback", lang)}
            </p>
            {lastErrorDetail && (
              <details className="mt-2">
                <summary className="text-[10.5px] text-[var(--color-ink-500)] cursor-pointer font-bold">
                  {t("obsPush.detailLabel", lang)}
                </summary>
                <p className="mt-1 text-[10.5px] font-mono break-all text-[var(--color-ink-600)] bg-white p-2 rounded">
                  {lastErrorDetail}
                </p>
              </details>
            )}
          </div>
        )}

        {/* ON/OFF 큰 버튼 */}
        {supported !== false && perm !== "denied" && (
          <Button
            block
            onClick={isOn ? disable : enable}
            loading={busy}
            variant={isOn ? "outline" : "primary"}
            leftIcon={isOn ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          >
            {isOn ? t("obsPush.btn.off", lang) : t("obsPush.btn.on", lang)}
          </Button>
        )}

        {/* 종류별 ON/OFF — 등록된 디바이스가 있을 때만 노출 */}
        {deviceCount > 0 && (
          <div className="rounded-[14px] border border-[var(--color-line)] divide-y divide-[var(--color-line)] bg-white">
            <PrefRow
              icon="🔔"
              label={t("obsPush.pref.newOrder", lang)}
              hint={t("obsPush.pref.newOrderHint", lang)}
              value={prefs?.newOrder !== false}
              onChange={(v) => onPrefChange({ newOrder: v })}
            />
            <PrefRow
              icon="💳"
              label={t("obsPush.pref.payment", lang)}
              hint={t("obsPush.pref.paymentHint", lang)}
              value={prefs?.paymentRequest !== false}
              onChange={(v) => onPrefChange({ paymentRequest: v })}
            />
            <PrefRow
              icon="🎟"
              label={t("obsPush.pref.coupon", lang)}
              hint={t("obsPush.pref.couponHint", lang)}
              value={prefs?.couponRequest !== false}
              onChange={(v) => onPrefChange({ couponRequest: v })}
            />
            <PrefRow
              icon="👤"
              label={t("obsPush.pref.staff", lang)}
              hint={t("obsPush.pref.staffHint", lang)}
              value={prefs?.staffJoin !== false}
              onChange={(v) => onPrefChange({ staffJoin: v })}
            />
          </div>
        )}

        {/* 안내 */}
        <div className="text-[11px] text-[var(--color-ink-500)] leading-relaxed border-t border-[var(--color-line)] pt-3 flex items-start gap-2">
          <Smartphone className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-bold text-[var(--color-ink-700)] mb-1">{t("obsPush.multi.title", lang)}</p>
            <p>
              {t("obsPush.multi.desc", lang)}
            </p>
          </div>
        </div>
      </div>
    </Sec>
  );
}

function PrefRow({
  icon, label, hint, value, onChange,
}: { icon: string; label: string; hint: string; value: boolean; onChange: (v: boolean) => void | Promise<void> }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="text-[18px]">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-bold text-[var(--color-navy-900)]">{label}</p>
        <p className="text-[11px] text-[var(--color-ink-500)] font-medium">{hint}</p>
      </div>
      <ToggleSwitch value={value} onChange={onChange} />
    </div>
  );
}

// ============================================================
// 영업 시간 섹션 — 요일별 시간 + 휴게시간 + 24시 + 임시 휴무일

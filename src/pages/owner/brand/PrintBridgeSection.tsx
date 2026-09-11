import { Sec, ToggleSwitch } from "./controls";
import { useEffect, useState } from "react";
import { KeyRound, Info, Printer, CheckCircle2 } from "lucide-react";
import { useLanguage, t, getLocale } from "../../../lib/i18n";
import { Button } from "../../../components/ui/Button";
import { showToast } from "../../../lib/toast";
import { issuePairingCode } from "../../../lib/printBridge";

// ============================================================
export function PrintBridgeSection({
  storeId,
  ownerName,
  enabled,
  device,
  onToggle,
}: {
  storeId: string;
  ownerName?: string;
  enabled: boolean;
  device?: { name?: string; pairedAt: string };
  onToggle: (v: boolean) => Promise<void>;
}) {
  const lang = useLanguage();
  const locale = getLocale(lang);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  // 카운트다운 — 5분 안에 안 쓰면 폐기
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const r = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setRemaining(r);
      if (r === 0) {
        setCode(null);
        setExpiresAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const requestCode = async () => {
    setBusy(true);
    try {
      const { code, expiresAt } = await issuePairingCode(storeId, ownerName);
      setCode(code);
      setExpiresAt(new Date(expiresAt).getTime());
      showToast(t("obsBridge.toast.issued", lang), "success");
    } catch (e: any) {
      showToast(t("obsBridge.toast.issueFail", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast(t("obsBridge.toast.copied", lang), "info");
    } catch {
      showToast(t("obsBridge.toast.copyFail", lang), "error");
    }
  };

  const mmss = (s: number) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  return (
    <Sec title={t("obsBridge.title", lang)}>
      <div className="space-y-3">
        {/* 토글 */}
        <div className="p-3.5 rounded-[14px] border border-[var(--color-line)] bg-white">
          <div className="flex items-start gap-3">
            <Printer className="w-5 h-5 text-[var(--color-navy-700)] mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-bold text-[var(--color-navy-900)]">{t("obsBridge.useAuto", lang)}</p>
              <p className="text-[12px] text-[var(--color-ink-600)] leading-relaxed mt-0.5">
                {t("obsBridge.useAutoDesc", lang)}
              </p>
            </div>
            <ToggleSwitch value={enabled} onChange={onToggle} />
          </div>
        </div>

        {/* 페어링 상태 */}
        {device ? (
          <div className="p-3.5 rounded-[14px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[var(--color-mint-700)] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-bold text-[var(--color-mint-700)]">
                  {t("obsBridge.connected", lang, { suffix: device.name ? ` · ${device.name}` : "" })}
                </p>
                <p className="text-[11.5px] text-[var(--color-mint-700)] font-medium opacity-90 mt-0.5">
                  {t("obsBridge.pairedAt", lang, { when: new Date(device.pairedAt).toLocaleString(locale) })}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3.5 rounded-[14px] bg-[var(--color-navy-50)] border border-[var(--color-navy-200)]">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-[var(--color-navy-700)] mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-[var(--color-navy-700)] font-semibold leading-relaxed">
                  {t("obsBridge.noneTitle", lang)}
                  <br />
                  <span className="font-medium opacity-90">
                    {t("obsBridge.noneDesc", lang)}
                  </span>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 코드 발급·표시 */}
        {code ? (
          <div className="p-4 rounded-[14px] bg-white border-2 border-[var(--color-navy-700)]">
            <p className="text-[11px] font-bold text-[var(--color-ink-500)] uppercase tracking-wider text-center">
              {t("obsBridge.codeLabel", lang, { time: mmss(remaining) })}
            </p>
            <button
              onClick={copyCode}
              className="w-full mt-2 text-[34px] font-extrabold text-[var(--color-navy-900)] tabular-nums tracking-[0.25em] text-center active:scale-[0.97] transition-transform"
              aria-label={t("obsBridge.codeCopy", lang)}
            >
              {code}
            </button>
            <p className="text-[11.5px] text-[var(--color-ink-500)] text-center mt-2">
              {t("obsBridge.codeHint", lang)}
            </p>
          </div>
        ) : (
          <Button
            block
            variant="outline"
            onClick={requestCode}
            loading={busy}
            leftIcon={<KeyRound className="w-4 h-4" />}
          >
            {device ? t("obsBridge.btn.repair", lang) : t("obsBridge.btn.issue", lang)}
          </Button>
        )}

        {/* 다운로드 버튼 — GitHub Releases 최신 버전을 OS 자동 감지로 안내 */}
        <a
          href="https://github.com/munyechan11-cell/-/releases/latest"
          target="_blank"
          rel="noreferrer noopener"
          className="block w-full text-center h-12 leading-[48px] rounded-[14px] bg-[var(--color-navy-700)] text-white text-[13px] font-bold hover:bg-[var(--color-navy-800)] active:scale-[0.98] transition-all"
        >
          {t("obsBridge.download", lang)}
        </a>

        {/* 다운로드 가이드 */}
        <div className="text-[11.5px] text-[var(--color-ink-500)] leading-relaxed border-t border-[var(--color-line)] pt-3">
          <p className="font-bold text-[var(--color-ink-700)] mb-1">{t("obsBridge.guide.title", lang)}</p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>{t("obsBridge.guide.step1", lang)}</li>
            <li>{t("obsBridge.guide.step2", lang)}</li>
            <li>{t("obsBridge.guide.step3", lang)}</li>
            <li>{t("obsBridge.guide.step4", lang)}</li>
          </ol>
        </div>
      </div>
    </Sec>
  );
}

// ============================================================
// 푸시 알림 섹션 — 권한 요청·디바이스 등록·종류별 ON/OFF

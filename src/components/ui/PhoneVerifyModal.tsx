/**
 * 전화번호 SMS 인증 모달.
 *
 * 두 가지 모드:
 *   1. signup — 가입 폼에서 호출. phone 은 외부에서 받고, 인증 성공 시 onVerified() 콜백.
 *      'X' / '나중에' 버튼 동작은 외부에서 결정 (signup 흐름에선 차단 권장).
 *   2. grandfather — 기존 가입자 강제 인증. 로그인 직후 phoneVerifiedAt 가 없으면 띄움.
 *      현재 phone 이 user.phone 인 점은 외부가 보장.
 *
 * 비용 누수 차단:
 *   - send 전 isValidKRPhone() 정규식 검증
 *   - 60초 재발송 쿨다운
 *   - busy 가드로 더블 클릭 방지
 *
 * UX:
 *   - reCAPTCHA badge invisible (auto)
 *   - 발송 후 코드 입력 단계로 자동 전환
 *   - 코드 자동 포커스
 *   - 모달 esc/배경 닫기 — signup 모드에선 차단, grandfather 모드에선 허용 안 함(강제)
 */
import { useEffect, useRef, useState } from "react";
import { useModalChrome } from "../../lib/useModalChrome";
import { Phone, ShieldCheck, X } from "lucide-react";
import { Button } from "./Button";
import { Input } from "./Input";
import { formatPhoneNumber, digitsOnly } from "../../lib/ids";
import { showToast } from "../../lib/toast";
import { useLanguage, t } from "../../lib/i18n";
import { confirmCode, isValidKRPhone, sendVerificationCode } from "../../lib/phoneVerify";

const RESEND_COOLDOWN_SEC = 60;

interface Props {
  /** 사전 입력된 전화번호 (가입 폼에서 받은 값). 비어 있으면 입력 폼 노출. */
  initialPhone?: string;
  /** grandfather 모드 — 기존 가입자 1회 강제 인증. 메시지 문구가 다름. */
  grandfather?: boolean;
  /** 닫기 허용 여부. signup/grandfather 모두 기본 false (인증 마쳐야 진행). */
  allowClose?: boolean;
  onClose?: () => void;
  onVerified: (e164: string) => void;
}

export function PhoneVerifyModal({
  initialPhone = "",
  grandfather = false,
  allowClose = false,
  onClose,
  onVerified,
}: Props) {
  const lang = useLanguage();
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"phone" | "code">("phone");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  // 발송한 번호. Supabase 는 검증 때 번호를 다시 요구한다(Firebase 의 ConfirmationResult 대체).
  const sentPhoneRef = useRef<string | null>(null);

  // 외부 prop 변화 sync — grandfather 모드에서 currentUser.phone 이 늦게 도착하는 케이스
  useEffect(() => {
    if (initialPhone) setPhone(initialPhone);
  }, [initialPhone]);

  // 쿨다운 타이머
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  // body 스크롤 잠금 + (allowClose 일 때만) ESC 닫기 — stack-safe
  useModalChrome(true, allowClose ? onClose : undefined);

  const send = async () => {
    if (sending) return;
    if (!isValidKRPhone(phone)) {
      showToast(t("phoneVerify.toast.invalidPhone", lang), "error");
      return;
    }
    setSending(true);
    try {
      await sendVerificationCode(phone);
      // 보낸 번호를 기억해 둔다 — 검증 때 같은 번호를 다시 넘겨야 한다.
      sentPhoneRef.current = phone;
      // stage 전환 시 옛 코드 잔존 방지 — 자동 verify 폭주 차단
      setCode("");
      setStage("code");
      setCooldown(RESEND_COOLDOWN_SEC);
      showToast(t("phoneVerify.toast.sent", lang), "info");
    } catch (e: any) {
      const msg = e?.code === "auth/invalid-phone-number"
        ? t("phoneVerify.toast.invalidPhone", lang)
        : e?.message ?? "";
      showToast(t("phoneVerify.toast.sendFail", lang, { msg }), "error");
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    if (verifying) return;
    const cleanCode = code.replace(/\D/g, "");
    if (cleanCode.length !== 6) {
      showToast(t("phoneVerify.toast.codeEmpty", lang), "error");
      return;
    }
    if (!sentPhoneRef.current) {
      showToast(t("phoneVerify.toast.expired", lang), "error");
      setStage("phone");
      return;
    }
    setVerifying(true);
    try {
      const { phone: verifiedE164 } = await confirmCode(sentPhoneRef.current, cleanCode);
      showToast(t("phoneVerify.toast.verified", lang), "success");
      onVerified(verifiedE164);
    } catch (e: any) {
      const code = String(e?.code ?? "");
      if (code.includes("invalid-verification-code")) {
        showToast(t("phoneVerify.toast.wrongCode", lang), "error");
      } else if (code.includes("code-expired")) {
        showToast(t("phoneVerify.toast.expired", lang), "error");
        setStage("phone");
        sentPhoneRef.current = null;
      } else {
        showToast(t("phoneVerify.toast.sendFail", lang, { msg: e?.message ?? "" }), "error");
      }
    } finally {
      setVerifying(false);
    }
  };

  const tryClose = () => {
    if (!allowClose) {
      showToast(t("phoneVerify.skipBlocked", lang), "info");
      return;
    }
    onClose?.();
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) tryClose(); }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full sm:max-w-[440px] bg-white sm:rounded-[20px] rounded-t-[20px] p-6 pb-[max(env(safe-area-inset-bottom),24px)] max-h-[92vh] overflow-y-auto"
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-navy-700)] text-white inline-flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)]">
              {t("phoneVerify.title", lang)}
            </h2>
            <p className="text-[12px] text-[var(--color-ink-500)] leading-snug">
              {grandfather ? t("phoneVerify.descGrandfather", lang) : t("phoneVerify.desc", lang)}
            </p>
          </div>
          {allowClose && (
            <button
              onClick={tryClose}
              aria-label={t("common.close", lang)}
              className="w-9 h-9 rounded-full hover:bg-[var(--color-ink-50)] inline-flex items-center justify-center"
            >
              <X className="w-4 h-4 text-[var(--color-ink-500)]" />
            </button>
          )}
        </div>

        {/* Stage 1: 전화번호 입력 + 발송 */}
        {stage === "phone" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <Input
              label={t("phoneVerify.phone", lang)}
              placeholder={t("phoneVerify.phonePh", lang)}
              value={phone}
              onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
              inputMode="tel"
              autoComplete="tel"
              leftSlot={<Phone className="w-4 h-4" />}
              /* 가입 폼에서 받은 번호는 원칙적으로 잠근다. 단, 그 번호가 발송 불가 형식이면
                 잠근 채로 두면 발송 버튼도 영구 비활성이라 사용자가 빠져나갈 수 없다
                 (X 버튼·ESC·배경 클릭이 모두 막힌 모달). 그때는 고칠 수 있게 풀어 준다. */
              disabled={!!initialPhone && !grandfather && isValidKRPhone(initialPhone)}
            />
            <Button
              block
              type="submit"
              loading={sending}
              disabled={!isValidKRPhone(phone) || sending}
            >
              {t("phoneVerify.send", lang)}
            </Button>
          </form>
        )}

        {/* Stage 2: 코드 입력 + 검증.
            form 으로 감싸 모바일 SMS 자동완성 후 Enter 키로 submit 가능. */}
        {stage === "code" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p className="text-[12.5px] text-[var(--color-ink-600)] tabular-nums">
              {phone}
            </p>
            <Input
              label={t("phoneVerify.codeLabel", lang)}
              placeholder={t("phoneVerify.codePh", lang)}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoFocus
              // iOS/Android SMS 자동완성 — 도착한 SMS 의 6자리를 자판 위에 띄움
              autoComplete="one-time-code"
            />
            <Button
              block
              type="submit"
              loading={verifying}
              disabled={code.length !== 6 || verifying}
            >
              {t("phoneVerify.confirm", lang)}
            </Button>
            <button
              type="button"
              onClick={send}
              disabled={cooldown > 0 || sending}
              className="w-full h-9 text-[12.5px] font-bold text-[var(--color-ink-600)] hover:text-[var(--color-navy-700)] disabled:opacity-50"
            >
              {cooldown > 0
                ? t("phoneVerify.resendIn", lang, { n: cooldown })
                : t("phoneVerify.resend", lang)}
            </button>
          </form>
        )}

        <p className="text-[10.5px] text-[var(--color-ink-400)] mt-3 leading-relaxed">
          protected by reCAPTCHA · {digitsOnly(phone).length} digits
        </p>
      </div>
    </div>
  );
}

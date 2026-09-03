import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Phone,
  Store as StoreIcon,
  Receipt,
  KeyRound,
  Lock,
  Info,
  MessageCircle,
  Briefcase,
  Crown,
} from "lucide-react";
import { MobileShell } from "../../components/layout/MobileShell";
import { TopBar } from "../../components/ui/TopBar";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { formatPhoneNumber, digitsOnly } from "../../lib/ids";
import { showToast } from "../../lib/toast";
import { useStore } from "../../store/store";
import { cn } from "../../lib/cn";
import { POS_VENDORS, getVendor, type PosVendor } from "../../lib/posVendors";
import { signInWithGoogle, signInWithKakao, consumeGoogleRedirect } from "../../lib/auth";
import type { SocialResult } from "../../lib/auth";
import { useLanguage, t } from "../../lib/i18n";
import { LanguagePill } from "../../components/ui/LanguagePill";
import { PhoneVerifyModal } from "../../components/ui/PhoneVerifyModal";
import { signInWithPhonePassword, signUpWithPhonePassword, MIN_PASSWORD_LENGTH } from "../../lib/phoneAuth";
import { phoneLoginEmail } from "../../lib/phoneLoginEmail";

type Mode = "login" | "signup";

export default function OwnerLogin() {
  const nav = useNavigate();
  const lang = useLanguage();
  const { login, users } = useStore();
  const [mode, setMode] = useState<Mode>("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [restaurantName, setRestaurantName] = useState("");
  const [posVendor, setPosVendor] = useState<PosVendor>("none");
  const [posApiKey, setPosApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPhoneVerify, setShowPhoneVerify] = useState(false);

  const vendorInfo = useMemo(() => getVendor(posVendor), [posVendor]);

  // 소셜 pending stash 파싱 — submit 과 verify 후 두 번 사용해 헬퍼화
  const readPendingSocial = () => {
    const stash =
      typeof window !== "undefined" ? sessionStorage.getItem("gyeol:pending-owner-social") : null;
    if (!stash) return null;
    try {
      const parsed = JSON.parse(stash) as {
        id: string; provider: "google" | "kakao"; avatarUrl?: string; ts?: number;
      };
      const fresh = !parsed.ts || Date.now() - parsed.ts < 10 * 60 * 1000;
      if (fresh && parsed.id && parsed.provider) {
        return { id: parsed.id, provider: parsed.provider, avatarUrl: parsed.avatarUrl };
      }
      sessionStorage.removeItem("gyeol:pending-owner-social");
    } catch {
      sessionStorage.removeItem("gyeol:pending-owner-social");
    }
    return null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.replace(/\D/g, "").length < 10 || !name.trim()) {
      showToast(t("ownerLogin.toast.fillNamePhone", lang), "error");
      return;
    }
    if (mode === "signup" && !restaurantName.trim()) {
      showToast(t("ownerLogin.toast.fillRestaurant", lang), "error");
      return;
    }
    if (!phoneLoginEmail(phone)) {
      showToast(t("auth.phone.invalid", lang), "error");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      showToast(t("auth.phone.weakPassword", lang), "error");
      return;
    }
    // 예전에는 가입 때 SMS 인증을 태웠다. 문자 발송 수단이 아직 없어 비밀번호로
    // 대신한다. 인증 없이 통과시키면 자격 증명이 없던 예전 구조로 돌아간다.
    setLoading(true);
    try {
      if (mode === "signup") await signUpWithPhonePassword(phone, password);
      else await signInWithPhonePassword(phone, password);
    } catch (err: any) {
      showToast(err?.message ?? t("auth.phone.wrongCredentials", lang), "error");
      setLoading(false);
      return;
    }
    setLoading(false);
    await runLogin();
  };

  // 실제 login() 호출 — submit 또는 PhoneVerifyModal onVerified 에서 진입.
  const runLogin = async (verified = false) => {
    const pendingSocial = readPendingSocial();
    setLoading(true);
    try {
      await login({
        phone,
        name,
        role: "owner",
        restaurantName: restaurantName || undefined,
        socialId: pendingSocial?.id,
        socialProvider: pendingSocial?.provider,
        authType: pendingSocial?.provider ?? "phone",
        avatarUrl: pendingSocial?.avatarUrl,
        posVendor: mode === "signup" ? posVendor : undefined,
        posApiKey: mode === "signup" ? posApiKey || undefined : undefined,
        // 소셜 pending 상태라면 신규 가입까지 허용
        signInOnly: mode === "login" && !pendingSocial,
        // ⚠️ 비밀번호 경로에서는 전화번호를 **증명하지 않았다.** 인증했다고 적으면
        //    나중에 그 값을 믿는 코드가 조용히 틀린다. 문자 인증을 통과한
        //    경우(verified)에만 찍는다.
        phoneVerifiedAt: verified ? new Date().toISOString() : undefined,
      });
      if (pendingSocial) sessionStorage.removeItem("gyeol:pending-owner-social");
      setShowPhoneVerify(false);
      nav("/biz/owner", { replace: true });
    } catch (e: any) {
      showToast(
        mode === "login"
          ? t("ownerLogin.toast.noAccount", lang)
          : t("ownerLogin.toast.signupFailed", lang, { msg: e?.message ?? "" }),
        "error"
      );
    } finally {
      setLoading(false);
    }
  };

  const applySocialResult = async (res: SocialResult) => {
    const existing = users.find(
      (u) =>
        u.role === "owner" &&
        u.status !== "deleted" &&
        (u.socialIds?.includes(res.id) ||
          u.googleId === res.id ||
          u.kakaoId === res.id)
    );

    if (existing) {
      await login({
        phone: existing.phone ?? "",
        name: existing.name,
        role: "owner",
        socialId: res.id,
        socialProvider: res.provider,
        authType: res.provider,
        avatarUrl: res.avatarUrl,
      });
      nav("/biz/owner", { replace: true });
      return;
    }

    if (mode === "login") {
      showToast(t("ownerLogin.toast.noExisting", lang), "info");
    }
    setMode("signup");
    if (res.name) setName(res.name);
    sessionStorage.setItem(
      "gyeol:pending-owner-social",
      JSON.stringify({ id: res.id, provider: res.provider, avatarUrl: res.avatarUrl, ts: Date.now() })
    );
    showToast(t("ownerLogin.toast.completeSignup", lang), "info");
  };

  // 인앱 브라우저 Google redirect 결과 회수
  useEffect(() => {
    consumeGoogleRedirect()
      .then((res) => { if (res) return applySocialResult(res); })
      .catch((e) => showToast(t("ownerLogin.toast.socialFailed", lang, { msg: e?.message ?? "" }), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSocial = async (provider: "google" | "kakao") => {
    setLoading(true);
    try {
      const res = provider === "google" ? await signInWithGoogle() : await signInWithKakao();
      await applySocialResult(res);
    } catch (e: any) {
      if (e?.message === "REDIRECT_IN_PROGRESS") return;
      showToast(t("ownerLogin.toast.socialFailed", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setLoading(false);
    }
  };

  // 가입 시 보관된 social 정보 사용
  // 소셜 가입 마무리도 전번 인증을 거친다. phone 이 비었거나 짧으면 차단.
  const finalizeSocialSignup = async (verified = false) => {
    const stash = sessionStorage.getItem("gyeol:pending-owner-social");
    if (!stash) return;
    const social = JSON.parse(stash) as { id: string; provider: "google" | "kakao"; avatarUrl?: string };
    if (!restaurantName.trim() || !name.trim()) {
      showToast(t("ownerLogin.toast.fillNameRestaurant", lang), "error");
      return;
    }
    if (!verified) {
      // phone 필수 — SMS 인증 필요
      if (phone.replace(/\D/g, "").length < 10) {
        showToast(t("ownerLogin.toast.fillNamePhone", lang), "error");
        return;
      }
      setShowPhoneVerify(true);
      return;
    }
    setLoading(true);
    try {
      await login({
        phone: digitsOnly(phone),
        name,
        role: "owner",
        restaurantName,
        socialId: social.id,
        socialProvider: social.provider,
        authType: social.provider,
        avatarUrl: social.avatarUrl,
        posVendor,
        posApiKey: posApiKey || undefined,
        phoneVerifiedAt: new Date().toISOString(),
      });
      sessionStorage.removeItem("gyeol:pending-owner-social");
      setShowPhoneVerify(false);
      nav("/biz/owner", { replace: true });
    } catch (e: any) {
      showToast(t("ownerLogin.toast.signupFailed", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setLoading(false);
    }
  };

  const hasSocialPending = typeof window !== "undefined" && !!sessionStorage.getItem("gyeol:pending-owner-social");

  return (
    <MobileShell>
      <TopBar title={t("ownerLogin.topbar", lang)} back right={<LanguagePill />} />
      <div className="px-6 pt-4 pb-16">
        {/* 사장님/직원 구분 안내 */}
        <div className="grid grid-cols-2 gap-2 mb-5">
          <div className="rounded-[14px] border-2 border-[var(--color-navy-700)] bg-[var(--color-navy-50)] p-3 flex items-center gap-2">
            <Crown className="w-4 h-4 text-[var(--color-navy-700)]" />
            <div>
              <p className="text-[11px] font-bold text-[var(--color-navy-700)] uppercase tracking-wide">{t("ownerLogin.chip.currentScreen", lang)}</p>
              <p className="text-[14px] font-extrabold text-[var(--color-navy-900)]">{t("ownerLogin.chip.owner", lang)}</p>
            </div>
          </div>
          <Link
            to="/biz/staff/login"
            className="rounded-[14px] border-[1.5px] border-[var(--color-line)] bg-white p-3 flex items-center gap-2 hover:border-[var(--color-mint-500)] transition-colors"
          >
            <Briefcase className="w-4 h-4 text-[var(--color-ink-500)]" />
            <div>
              <p className="text-[11px] font-bold text-[var(--color-ink-600)] uppercase tracking-wide">{t("ownerLogin.chip.areYouStaff", lang)}</p>
              <p className="text-[14px] font-extrabold text-[var(--color-ink-700)]">{t("ownerLogin.chip.staffJoin", lang)}</p>
            </div>
          </Link>
        </div>

        <h1 className="headline-section mb-1">
          {mode === "login" ? t("ownerLogin.h1.login", lang) : hasSocialPending ? t("ownerLogin.h1.signupSocial", lang) : t("ownerLogin.h1.signupNew", lang)}
        </h1>
        <p className="body-md text-[var(--color-ink-500)]">
          {t("ownerLogin.subtitle", lang)}
        </p>

        <div className="mt-6 grid grid-cols-2 p-1 bg-[var(--color-navy-50)] rounded-[14px]">
          {(["login", "signup"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "h-11 rounded-[10px] text-[13.5px] font-bold tracking-tight transition-all",
                mode === m
                  ? "bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]"
                  : "text-[var(--color-ink-500)]"
              )}
            >
              {m === "login" ? t("ownerLogin.tab.login", lang) : t("ownerLogin.tab.signup", lang)}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            if (hasSocialPending && mode === "signup") {
              e.preventDefault();
              finalizeSocialSignup();
            } else {
              submit(e);
            }
          }}
          className="mt-7 space-y-4"
        >
          <Input
            label={t("ownerLogin.field.name", lang)}
            placeholder={t("ownerLogin.field.namePh", lang)}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            label={hasSocialPending && mode === "signup" ? t("ownerLogin.field.phoneOpt", lang) : t("ownerLogin.field.phone", lang)}
            placeholder="010-0000-0000"
            value={phone}
            onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
            inputMode="numeric"
            leftSlot={<Phone className="w-4 h-4" />}
          />
          {!hasSocialPending && (
            <Input
              label={t("auth.phone.password", lang)}
              placeholder={t("auth.phone.passwordPlaceholder", lang)}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              leftSlot={<Lock className="w-4 h-4" />}
            />
          )}
          {mode === "signup" && (
            <>
              <Input
                label={t("ownerLogin.field.restaurant", lang)}
                placeholder={t("ownerLogin.field.restaurantPh", lang)}
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
                leftSlot={<StoreIcon className="w-4 h-4" />}
              />

              <div>
                <label className="block text-[13px] font-semibold text-[var(--color-navy-800)] mb-2">
                  {t("ownerLogin.field.pos", lang)}
                </label>
                <div className="relative">
                  <select
                    value={posVendor}
                    onChange={(e) => setPosVendor(e.target.value as PosVendor)}
                    className="input-field appearance-none pr-10"
                  >
                    {POS_VENDORS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                  <Receipt className="w-4 h-4 absolute right-4 top-1/2 -translate-y-1/2 text-[var(--color-ink-400)] pointer-events-none" />
                </div>
              </div>

              {vendorInfo.needsApiKey ? (
                <Input
                  label={t("ownerLogin.field.apiKeyLabel", lang, { label: vendorInfo.keyLabel ?? t("ownerLogin.field.apiKeyDefault", lang) })}
                  placeholder={vendorInfo.placeholder ?? t("ownerLogin.field.apiKeyPh", lang)}
                  value={posApiKey}
                  onChange={(e) => setPosApiKey(e.target.value)}
                  leftSlot={<KeyRound className="w-4 h-4" />}
                  hint={
                    posApiKey
                      ? vendorInfo.hint ?? t("ownerLogin.field.apiKeyHintWith", lang)
                      : t("ownerLogin.field.apiKeyHintEmpty", lang)
                  }
                />
              ) : (
                <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]">
                  <Info className="w-4 h-4 text-[var(--color-mint-700)] mt-0.5 shrink-0" />
                  <p className="text-[12px] text-[var(--color-mint-700)] font-semibold leading-relaxed">
                    {vendorInfo.hint ?? t("ownerLogin.field.noPosHint", lang)}
                    <br />
                    <span className="font-medium opacity-90">
                      {t("ownerLogin.field.autoPrintNote", lang)}
                    </span>
                  </p>
                </div>
              )}
            </>
          )}

          <Button
            block
            type="submit"
            loading={loading}
            disabled={!name || (mode === "signup" && !restaurantName) || (!hasSocialPending && !phone)}
          >
            {mode === "login" ? t("ownerLogin.btn.login", lang) : t("ownerLogin.btn.signup", lang)}
          </Button>
        </form>

        {mode === "login" && !hasSocialPending && (
          <>
            <div className="my-7 flex items-center gap-3 text-[12px] text-[var(--color-ink-300)] font-semibold">
              <div className="flex-1 h-px bg-[var(--color-line)]" />
              {t("ownerLogin.orSocial", lang)}
              <div className="flex-1 h-px bg-[var(--color-line)]" />
            </div>
            <div className="space-y-3">
              <Button variant="outline" block onClick={() => handleSocial("google")} loading={loading}>
                {t("ownerLogin.btn.google", lang)}
              </Button>
              <button
                onClick={() => handleSocial("kakao")}
                disabled={loading}
                className="w-full h-14 rounded-[14px] bg-[#FEE500] text-[#191919] font-bold inline-flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-40"
              >
                <MessageCircle className="w-5 h-5" />
                {t("ownerLogin.btn.kakao", lang)}
              </button>
            </div>
          </>
        )}

        {mode === "signup" && !hasSocialPending && (
          <p className="mt-4 text-[12px] text-[var(--color-ink-500)] text-center">
            {t("ownerLogin.signupNote", lang)}
          </p>
        )}
      </div>
      {showPhoneVerify && (
        <PhoneVerifyModal
          initialPhone={phone}
          onVerified={() =>
            hasSocialPending && mode === "signup"
              ? finalizeSocialSignup(true)
              : runLogin(true)
          }
        />
      )}
    </MobileShell>
  );
}

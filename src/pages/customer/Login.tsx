import { useState, useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { MessageCircle, Phone, Mars, Venus, Check, Store as StoreIcon, Armchair, MapPin } from "lucide-react";
import { MobileShell } from "../../components/layout/MobileShell";
import { TopBar } from "../../components/ui/TopBar";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { formatPhoneNumber, digitsOnly } from "../../lib/ids";
import { showToast } from "../../lib/toast";
import { useStore } from "../../store/store";
import { signInWithGoogle, signInWithKakao, consumeGoogleRedirect } from "../../lib/auth";
import type { SocialResult } from "../../lib/auth";
import { cn } from "../../lib/cn";
import { TERMS, type TermKey, type TermDoc } from "../../lib/terms";
import { TermsModal } from "../../components/ui/TermsModal";
import { useLanguage, t } from "../../lib/i18n";
import { LanguagePill } from "../../components/ui/LanguagePill";
import { PhoneVerifyModal } from "../../components/ui/PhoneVerifyModal";

type Step = 1 | 2 | 3;
type Mode = "login" | "signup";

export default function CustomerLogin() {
  const nav = useNavigate();
  const { storeId } = useParams();
  const [params] = useSearchParams();
  const tableNum = params.get("table");
  const { login, users } = useStore();
  const lang = useLanguage();

  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [social, setSocial] = useState<{ id: string; provider: "google" | "kakao"; avatarUrl?: string } | null>(
    null
  );
  const [gender, setGender] = useState<"male" | "female" | null>(null);
  const [birthYear, setBirthYear] = useState("");
  const [birthMonth, setBirthMonth] = useState("");
  const [birthDay, setBirthDay] = useState("");
  // 포항시 거주 여부 — 지역 단골 혜택 통계에 사용. null = 미선택
  const [isPohangResident, setIsPohangResident] = useState<boolean | null>(null);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const [agreeService, setAgreeService] = useState(false);
  const [agreeMarketing, setAgreeMarketing] = useState(false);
  const [viewingTerm, setViewingTerm] = useState<TermDoc | null>(null);
  const [loading, setLoading] = useState(false);
  // 가입 마지막 단계 — 전번 SMS 인증 모달. 인증 성공 시 실제 login() 호출.
  const [showPhoneVerify, setShowPhoneVerify] = useState(false);

  const onAfterLogin = () => {
    // QR로 진입한 경우만 그 매장으로 복귀, 그 외엔 내 개인 대시보드
    const target = storeId
      ? tableNum
        ? `/customer/store/${storeId}/table/${tableNum}`
        : `/customer/store/${storeId}`
      : "/customer";
    nav(target, { replace: true });
  };

  const applySocialResult = async (res: SocialResult) => {
    // 기존 계정이면 바로 로그인 (재가입 절차 생략)
    const existing = users.find(
      (u) =>
        u.role === "customer" &&
        u.status !== "deleted" &&
        (u.socialIds?.includes(res.id) ||
          u.googleId === res.id ||
          u.kakaoId === res.id)
    );

    if (existing) {
      await login({
        phone: existing.phone ?? "",
        name: existing.name,
        role: "customer",
        socialId: res.id,
        socialProvider: res.provider,
        authType: res.provider,
        avatarUrl: res.avatarUrl,
      });
      onAfterLogin();
      return;
    }

    // 신규: 가입 모드로 자동 전환 + step 1 (phone 받기)
    // 소셜 가입은 step 2(성별·생일·거주) 를 건너뛰므로, 그 자리의 state 들이
    // 이전 일반 가입 시도의 stale 값으로 남으면 안 됨 → 명시적으로 초기화.
    setMode("signup");
    setSocial({ id: res.id, provider: res.provider, avatarUrl: res.avatarUrl });
    if (res.name) setName(res.name);
    setGender(null);
    setBirthYear("");
    setBirthMonth("");
    setBirthDay("");
    setIsPohangResident(null);
    setStep(1);
  };

  // 인앱 브라우저(카톡 등)에서 Google redirect로 돌아온 경우 결과 회수
  useEffect(() => {
    consumeGoogleRedirect()
      .then((res) => { if (res) return applySocialResult(res); })
      .catch((e) => showToast(t("login.err.socialFail", undefined, { msg: e?.message ?? "" }), "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSocial = async (provider: "google" | "kakao") => {
    setLoading(true);
    try {
      const res = provider === "google" ? await signInWithGoogle() : await signInWithKakao();
      await applySocialResult(res);
    } catch (e: any) {
      // 리다이렉트 시작은 에러 아님 — 페이지가 곧 이동함
      if (e?.message === "REDIRECT_IN_PROGRESS") return;
      showToast(t("login.err.socialFail", undefined, { msg: e?.message ?? "" }), "error");
    } finally {
      setLoading(false);
    }
  };

  // ===== 로그인 모드 =====
  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.replace(/\D/g, "").length < 10) {
      showToast(t("login.err.phone"), "error");
      return;
    }
    const cleanPhone = digitsOnly(phone);
    const existing = users.find(
      (u) =>
        u.role === "customer" &&
        u.status !== "deleted" &&
        digitsOnly(u.phone || "") === cleanPhone
    );
    if (!existing) {
      showToast(
        t("login.err.notFound"),
        "error"
      );
      return;
    }
    setLoading(true);
    try {
      await login({
        phone,
        name: existing.name,
        role: "customer",
        authType: "phone",
        signInOnly: true,
      });
      onAfterLogin();
    } catch (e: any) {
      showToast(t("login.err.loginFail", undefined, { msg: e?.message ?? "" }), "error");
    } finally {
      setLoading(false);
    }
  };

  // ===== 회원가입 step 1 =====
  const submitStep1 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || phone.replace(/\D/g, "").length < 10) {
      showToast(t("login.err.nameAndPhone"), "error");
      return;
    }
    // 회원가입 모드라도 기존 계정 발견되면 즉시 로그인 처리 (재가입 방지)
    const cleanPhone = digitsOnly(phone);
    const existing = users.find(
      (u) =>
        u.role === "customer" &&
        u.status !== "deleted" &&
        digitsOnly(u.phone || "") === cleanPhone
    );
    if (existing) {
      setLoading(true);
      try {
        await login({
          phone,
          name: existing.name || name,
          role: "customer",
          // 소셜로 들어온 신규-flow에서 기존 전화 계정이 잡히면 소셜 ID를 함께 연결
          socialId: social?.id,
          socialProvider: social?.provider,
          authType: social?.provider ?? "phone",
          avatarUrl: social?.avatarUrl,
        });
        showToast(
          social
            ? t("login.info.alreadyJoinedLinked", undefined, { provider: social.provider === "google" ? "Google" : "Kakao" })
            : t("login.info.alreadyJoined"),
          "info"
        );
        onAfterLogin();
      } catch (e: any) {
        showToast(t("login.err.loginFail", undefined, { msg: e?.message ?? "" }), "error");
      } finally {
        setLoading(false);
      }
      return;
    }
    // 소셜 가입은 step 2(성별·생일·거주) 건너뛰고 바로 약관(step 3)으로
    // 일반 가입은 step 2 → step 3 풀 흐름
    setStep(social ? 3 : 2);
  };

  const submitStep2 = () => {
    if (!gender) {
      showToast(t("login.err.gender"), "error");
      return;
    }
    const y = Number(birthYear);
    const m = Number(birthMonth);
    const d = Number(birthDay);
    const thisYear = new Date().getFullYear();
    if (!y || y < 1900 || y > thisYear) {
      showToast(t("login.err.birthYear"), "error");
      return;
    }
    if (!m || m < 1 || m > 12) {
      showToast(t("login.err.birthMonth"), "error");
      return;
    }
    // 해당 월의 마지막 일 계산
    const lastDay = new Date(y, m, 0).getDate();
    if (!d || d < 1 || d > lastDay) {
      showToast(t("login.err.birthDay", undefined, { max: lastDay }), "error");
      return;
    }
    if (isPohangResident === null) {
      showToast(t("login.err.region"), "error");
      return;
    }
    setStep(3);
  };

  const submitStep3 = () => {
    if (!agreePrivacy || !agreeService) {
      showToast(t("login.err.requiredTerms"), "error");
      return;
    }
    // 약관 통과 → 전번 SMS 인증 단계로. 소셜·일반 모두 "가입 시 1회" 인증해
    // 전화번호 신뢰성을 확보한다(사장님 데이터 활용). 인증 후에는 재인증 없음.
    setShowPhoneVerify(true);
  };

  // 가입 완료 → login() 호출. SMS 인증 성공 후 호출되며 phoneVerifiedAt 마킹(가입 시 1회).
  const completeSignup = async () => {
    setLoading(true);
    // Firestore 쓰기는 오프라인/연결불가 상태에서 promise 가 영원히 pending 이다(에러도 안 남).
    // 그대로 두면 "인증되었어요" 토스트만 뜬 채 모달이 닫히지 않아 원인을 알 수 없다.
    // 상한을 둬 조용한 멈춤을 눈에 보이는 실패로 바꾼다.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 20000);
    });
    try {
      await Promise.race([timeout, login({
        phone,
        name,
        role: "customer",
        socialId: social?.id,
        socialProvider: social?.provider,
        authType: social?.provider ?? "phone",
        avatarUrl: social?.avatarUrl,
        gender: gender ?? undefined,
        birthYear: birthYear ? Number(birthYear) : undefined,
        // 소셜 가입(step 2 스킵)일 땐 birthday 가 모두 빈 문자열 → 잘못된 '--' 값 저장 방지
        birthday: birthYear && birthMonth && birthDay
          ? `${birthYear}-${birthMonth.padStart(2, "0")}-${birthDay.padStart(2, "0")}`
          : undefined,
        isPohangResident: isPohangResident ?? undefined,
        privacyAgreedAt: new Date().toISOString(),
        phoneVerifiedAt: new Date().toISOString(), // 가입 시 1회 인증 완료 마킹
      })]);
      setShowPhoneVerify(false);
      onAfterLogin();
    } catch (e: any) {
      // 원인 특정용 — Firebase 는 code 에 실제 사유가 담긴다(permission-denied 등).
      console.error("[completeSignup]", e?.code ?? "", e);
      const msg =
        e?.message === "timeout"
          ? t("login.err.signupTimeout")
          : t("login.err.signupFail", undefined, { msg: e?.code ?? e?.message ?? "" });
      showToast(msg, "error");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  // 회원가입 모드 진행 중(step 2/3)이면 진짜 가입 중. 토글 표시 안 함.
  const showModeToggle = step === 1 && !social;

  // QR 진입 컨텍스트: 매장명 + 테이블 번호
  const qrStore = storeId ? users.find((u) => u.id === storeId && u.role === "owner") : undefined;
  const showQrContext = !!storeId && !!tableNum;

  return (
    <MobileShell>
      <TopBar
        title={
          mode === "login"
            ? t("login.title.login", lang)
            : step === 1
            ? t("login.title.signup", lang)
            : // 소셜 가입은 2단계, 일반은 3단계
              social
              ? t("login.title.signupStep", lang, { cur: 2, total: 2 })
              : t("login.title.signupStep", lang, { cur: step - 1, total: 2 })
        }
        back
        right={<LanguagePill />}
      />
      <div className="px-6 pt-2">
        {/* QR 다이렉트 진입 시 매장/테이블 컨텍스트 배너 — 모바일에서 키보드 띄워도 안 가리도록 컴팩트 */}
        {showQrContext && (
          <div className="mt-3 rounded-[14px] border-[1.5px] border-[var(--color-mint-200)] bg-[var(--color-mint-50)] px-3 py-2 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] bg-white flex items-center justify-center shrink-0 shadow-[var(--shadow-press)]">
              <Armchair className="w-4 h-4 text-[var(--color-mint-700)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-extrabold text-[var(--color-navy-900)] truncate flex items-center gap-1">
                <StoreIcon className="w-3 h-3 text-[var(--color-ink-500)] shrink-0" />
                <span className="truncate">{qrStore?.restaurantName ?? t("common.store", lang)}</span>
                <span className="text-[var(--color-ink-400)] mx-0.5">·</span>
                <span className="text-[var(--color-mint-700)] whitespace-nowrap">{t("login.qrTable", lang, { n: tableNum ?? "" })}</span>
              </p>
              <p className="text-[11px] text-[var(--color-ink-500)] font-medium leading-tight">
                {t("login.qrAutoConnect", lang)}
              </p>
            </div>
          </div>
        )}

        {/* 로그인/회원가입 토글 — step 1에서만 노출 */}
        {showModeToggle && (
          <div className="mt-4 grid grid-cols-2 p-1 bg-[var(--color-navy-50)] rounded-[14px]">
            {(["login", "signup"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  // 모드 변경 시 입력 정리 (이름은 보존)
                  if (m === "login") setSocial(null);
                }}
                className={cn(
                  "h-11 rounded-[10px] text-[13.5px] font-bold tracking-tight transition-all",
                  mode === m
                    ? "bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]"
                    : "text-[var(--color-ink-500)]"
                )}
              >
                {m === "login" ? t("login.mode.login", lang) : t("login.mode.signup", lang)}
              </button>
            ))}
          </div>
        )}

        {/* 회원가입 진행 중(step 2/3)이면 Stepper */}
        {mode === "signup" && step > 1 && <Stepper step={step} total={social ? 2 : 3} />}

        {/* ===== 로그인 모드 ===== */}
        {mode === "login" && (
          <>
            <h1 className="headline-section mt-6 mb-1">{t("login.welcomeBack", lang)}</h1>
            <p className="body-md text-[var(--color-ink-500)]">
              {t("login.welcomeBackDesc", lang)}
            </p>
            <form onSubmit={submitLogin} className="mt-7 space-y-4">
              <Input
                label={t("login.phone", lang)}
                placeholder={t("login.phonePlaceholder", lang)}
                value={phone}
                onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
                inputMode="numeric"
                autoComplete="tel"
                leftSlot={<Phone className="w-4 h-4" />}
              />
              <Button block type="submit" loading={loading} disabled={!phone}>
                {t("login.btn.login", lang)}
              </Button>
            </form>

            <div className="my-7 flex items-center gap-3 text-[13px] text-[var(--color-ink-500)] font-semibold">
              <div className="flex-1 h-px bg-[var(--color-line)]" />
              {t("login.orSocial", lang)}
              <div className="flex-1 h-px bg-[var(--color-line)]" />
            </div>
            <div className="space-y-3">
              <Button variant="outline" block onClick={() => handleSocial("google")} loading={loading}>
                {t("login.btn.googleLogin", lang)}
              </Button>
              <button
                onClick={() => handleSocial("kakao")}
                disabled={loading}
                className="w-full h-14 rounded-[14px] bg-[#FEE500] text-[#191919] font-bold inline-flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-40"
              >
                <MessageCircle className="w-5 h-5" />
                {t("login.btn.kakaoLogin", lang)}
              </button>
            </div>

            <p className="mt-6 text-center text-[12px] text-[var(--color-ink-500)]">
              {t("login.notMember", lang)}{" "}
              <button
                onClick={() => setMode("signup")}
                className="font-bold text-[var(--color-navy-700)] underline"
              >
                {t("login.signupLink", lang)}
              </button>
            </p>
          </>
        )}

        {/* ===== 회원가입 모드 — step 1 ===== */}
        {mode === "signup" && step === 1 && (
          <>
            <h1 className="headline-section mt-6 mb-1">
              {social
                ? social.provider === "google" ? t("login.signupGoogle", lang) : t("login.signupKakao", lang)
                : t("login.signupHi", lang)}
            </h1>
            <p className="body-md text-[var(--color-ink-500)]">
              {social ? t("login.signupSocialDesc", lang) : t("login.signupPhoneDesc", lang)}
            </p>
            <form onSubmit={submitStep1} className="mt-7 space-y-4">
              <Input
                label={t("login.name", lang)}
                placeholder={t("login.namePlaceholder", lang)}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
              <Input
                label={t("login.phone", lang)}
                placeholder={t("login.phonePlaceholder", lang)}
                value={phone}
                onChange={(e) => setPhone(formatPhoneNumber(e.target.value))}
                inputMode="numeric"
                autoComplete="tel"
                leftSlot={<Phone className="w-4 h-4" />}
                hint={t("login.phoneHint", lang)}
              />
              <Button block type="submit" disabled={!phone || !name} loading={loading}>
                {t("login.btn.next", lang)}
              </Button>
            </form>

            {!social && (
              <>
                <div className="my-7 flex items-center gap-3 text-[12px] text-[var(--color-ink-300)] font-semibold">
                  <div className="flex-1 h-px bg-[var(--color-line)]" />
                  {t("login.orSocial", lang)}
                  <div className="flex-1 h-px bg-[var(--color-line)]" />
                </div>
                <div className="space-y-3">
                  <Button variant="outline" block onClick={() => handleSocial("google")} loading={loading}>
                    {t("login.btn.googleContinue", lang)}
                  </Button>
                  <button
                    onClick={() => handleSocial("kakao")}
                    disabled={loading}
                    className="w-full h-14 rounded-[14px] bg-[#FEE500] text-[#191919] font-bold inline-flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-40"
                  >
                    <MessageCircle className="w-5 h-5" />
                    {t("login.btn.kakaoContinue", lang)}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {mode === "signup" && step === 2 && (
          <>
            <h2 className="headline-section mt-6 mb-1">{t("login.basicInfo", lang)}</h2>
            <p className="body-md text-[var(--color-ink-500)]">
              {t("login.basicInfoDesc", lang)}
            </p>

            <div className="mt-7">
              <p className="text-[13px] font-semibold text-[var(--color-navy-800)] mb-2">{t("login.gender", lang)}</p>
              <div className="grid grid-cols-2 gap-3">
                <GenderChip active={gender === "male"} onClick={() => setGender("male")}>
                  <Mars className="w-4 h-4" /> {t("login.male", lang)}
                </GenderChip>
                <GenderChip active={gender === "female"} onClick={() => setGender("female")}>
                  <Venus className="w-4 h-4" /> {t("login.female", lang)}
                </GenderChip>
              </div>
            </div>

            <div className="mt-6">
              <p className="text-[13px] font-semibold text-[var(--color-navy-800)] mb-2">{t("login.birthday", lang)}</p>
              <div className="grid grid-cols-3 gap-2">
                <Input placeholder="YYYY" inputMode="numeric" maxLength={4} value={birthYear}
                  onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ""))} />
                <Input placeholder="MM" inputMode="numeric" maxLength={2} value={birthMonth}
                  onChange={(e) => setBirthMonth(e.target.value.replace(/\D/g, ""))} />
                <Input placeholder="DD" inputMode="numeric" maxLength={2} value={birthDay}
                  onChange={(e) => setBirthDay(e.target.value.replace(/\D/g, ""))} />
              </div>
            </div>

            <div className="mt-6">
              <p className="text-[13px] font-semibold text-[var(--color-navy-800)] mb-1">{t("login.region", lang)}</p>
              <p className="text-[11.5px] text-[var(--color-ink-500)] mb-2">{t("login.regionDesc", lang)}</p>
              <div className="grid grid-cols-2 gap-3">
                <ResidenceChip active={isPohangResident === true} onClick={() => setIsPohangResident(true)}>
                  <MapPin className="w-4 h-4" /> {t("login.regionLocal", lang)}
                </ResidenceChip>
                <ResidenceChip active={isPohangResident === false} onClick={() => setIsPohangResident(false)}>
                  <MapPin className="w-4 h-4" /> {t("login.regionOther", lang)}
                </ResidenceChip>
              </div>
            </div>

            <Button block className="mt-8" onClick={submitStep2}>{t("login.btn.next", lang)}</Button>
          </>
        )}

        {mode === "signup" && step === 3 && (
          <>
            <h2 className="headline-section mt-6 mb-1">{t("login.terms", lang)}</h2>
            <p
              className="body-md text-[var(--color-ink-500)]"
              dangerouslySetInnerHTML={{ __html: t("login.termsDesc", lang) }}
            />

            <div className="mt-7 space-y-3">
              <Agree
                checked={agreePrivacy && agreeService && agreeMarketing}
                onClick={() => {
                  const next = !(agreePrivacy && agreeService && agreeMarketing);
                  setAgreePrivacy(next);
                  setAgreeService(next);
                  setAgreeMarketing(next);
                }}
                bold
              >
                {t("login.agreeAll", lang)}
              </Agree>
              <div className="h-px bg-[var(--color-line)]" />

              <AgreeRow
                term={TERMS.privacy}
                checked={agreePrivacy}
                onToggle={() => setAgreePrivacy((v) => !v)}
                onView={() => setViewingTerm(TERMS.privacy)}
              />
              <AgreeRow
                term={TERMS.service}
                checked={agreeService}
                onToggle={() => setAgreeService((v) => !v)}
                onView={() => setViewingTerm(TERMS.service)}
              />
              <AgreeRow
                term={TERMS.marketing}
                checked={agreeMarketing}
                onToggle={() => setAgreeMarketing((v) => !v)}
                onView={() => setViewingTerm(TERMS.marketing)}
              />
            </div>

            <Button block className="mt-8" onClick={submitStep3} loading={loading}>
              {t("login.btn.finish", lang)}
            </Button>
          </>
        )}

        {/* 약관 보기 모달 */}
        {viewingTerm && (
          <TermsModal term={viewingTerm} onClose={() => setViewingTerm(null)} />
        )}
        {showPhoneVerify && (
          <PhoneVerifyModal
            initialPhone={phone}
            onVerified={completeSignup}
          />
        )}
      </div>
    </MobileShell>
  );
}

function Stepper({ step, total = 3 }: { step: Step; total?: number }) {
  // 소셜 가입은 2단계, 일반 가입은 3단계
  const bars = Array.from({ length: total }, (_, i) => i + 1);
  // total=2 모드에선 step 3 도 2 로 표시 (실제로는 step 3 = 약관 = 마지막)
  const active = total === 2 ? Math.min(step - (step === 3 ? 1 : 0), 2) : step;
  return (
    <div className="mt-4 flex items-center gap-2">
      {bars.map((s) => (
        <div
          key={s}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors",
            s <= active ? "bg-[var(--color-navy-700)]" : "bg-[var(--color-ink-100)]"
          )}
        />
      ))}
    </div>
  );
}

function GenderChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-14 rounded-[14px] font-bold text-[15px] inline-flex items-center justify-center gap-2 border-[1.5px] transition-all",
        active
          ? "border-[var(--color-navy-700)] bg-[var(--color-navy-50)] text-[var(--color-navy-800)]"
          : "border-[var(--color-line)] bg-white text-[var(--color-ink-500)]"
      )}
    >
      {children}
    </button>
  );
}

// 거주 지역 — GenderChip 과 동일 스타일이지만 색상은 mint 계열로 시각적 구분
function ResidenceChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-14 rounded-[14px] font-bold text-[14.5px] inline-flex items-center justify-center gap-2 border-[1.5px] transition-all",
        active
          ? "border-[var(--color-mint-700)] bg-[var(--color-mint-50)] text-[var(--color-mint-700)]"
          : "border-[var(--color-line)] bg-white text-[var(--color-ink-500)]"
      )}
    >
      {children}
    </button>
  );
}

// ============================================================
// AgreeRow — 약관 한 줄 (체크박스 + 필수/선택 라벨 + '왜?' 설명 + '보기' 버튼)
// ============================================================
function AgreeRow({
  term,
  checked,
  onToggle,
  onView,
}: {
  term: TermDoc;
  checked: boolean;
  onToggle: () => void;
  onView: () => void;
}) {
  const lang = useLanguage();
  return (
    <div className="rounded-[12px] border border-[var(--color-line)] bg-white p-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggle}
          className={cn(
            "w-6 h-6 rounded-md border-[1.5px] flex items-center justify-center transition-colors shrink-0",
            checked ? "bg-[var(--color-navy-700)] border-[var(--color-navy-700)]" : "border-[var(--color-ink-300)] bg-white"
          )}
          aria-label={`${term.title}`}
          aria-checked={checked}
          role="checkbox"
        >
          {checked && <Check className="w-4 h-4 text-white" />}
        </button>
        <button onClick={onToggle} className="flex-1 min-w-0 text-left">
          <span className={cn(
            "text-[11px] font-extrabold mr-1.5 px-1.5 py-0.5 rounded",
            term.required
              ? "bg-[#fef2f2] text-[var(--color-danger)]"
              : "bg-[var(--color-ink-50)] text-[var(--color-ink-600)]"
          )}>
            {term.required ? t("login.required", lang) : t("login.optional", lang)}
          </span>
          <span className="text-[14px] font-bold text-[var(--color-navy-900)]">{term.title}</span>
        </button>
        <button
          onClick={onView}
          className="text-[11.5px] font-bold text-[var(--color-navy-700)] hover:underline px-2 py-1 rounded shrink-0"
        >
          {t("login.view", lang)}
        </button>
      </div>
      {/* '왜 필요한가요' 한 줄 설명 */}
      <p className="text-[11.5px] text-[var(--color-ink-600)] mt-1.5 ml-9 leading-relaxed">
        {term.why}
      </p>
    </div>
  );
}

function Agree({
  checked,
  onClick,
  children,
  bold,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 py-2 text-left"
    >
      <span
        className={cn(
          "w-6 h-6 rounded-md border-[1.5px] flex items-center justify-center transition-colors",
          checked
            ? "bg-[var(--color-navy-700)] border-[var(--color-navy-700)]"
            : "border-[var(--color-ink-300)] bg-white"
        )}
      >
        {checked && <Check className="w-4 h-4 text-white" />}
      </span>
      <span
        className={cn(
          "text-[14px]",
          bold ? "font-extrabold text-[var(--color-navy-900)]" : "font-medium text-[var(--color-ink-700)]"
        )}
      >
        {children}
      </span>
    </button>
  );
}

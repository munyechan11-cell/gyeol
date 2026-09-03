import { useEffect, useMemo, useState } from "react";
import { MapPin, Save, Receipt, KeyRound, Info, Printer, Plug, CheckCircle2, AlertCircle, Languages } from "lucide-react";
import { LANGS, useLanguage, setLanguage, t } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useStore } from "../../store/store";
import { api, authHeaders } from "../../lib/api";
import { showToast } from "../../lib/toast";
import { getCurrentPosition } from "../../lib/geo";
import { TIER_ORDER } from "../../lib/tier";
import { POS_VENDORS, getVendor, type PosVendor } from "../../lib/posVendors";
import { isWebUsbSupported, requestPrinter, getAuthorizedPrinters, printTestPage } from "../../lib/thermalPrinter";
import type { Industry, RewardType } from "../../lib/types";
import { THEMES, applyTheme, defaultThemeForIndustry } from "../../lib/themes";
import { SITE_FONTS, googleFontsHref } from "../../lib/siteFonts";
import { Sec, Pill, ToggleSwitch, Toggle } from "./brand/controls";
import { PrintBridgeSection } from "./brand/PrintBridgeSection";
import { PushNotificationSection } from "./brand/PushNotificationSection";
import { BusinessHoursSection } from "./brand/BusinessHoursSection";

export default function BrandSettings() {
  const { currentUser, updateBrandSettings, updateStoreConfig, updateStoreLocation } = useStore();
  const [printerInfo, setPrinterInfo] = useState<{ name: string } | null>(null);
  const [printerBusy, setPrinterBusy] = useState(false);

  useEffect(() => {
    if (!isWebUsbSupported()) return;
    getAuthorizedPrinters().then((devs) => {
      if (devs.length > 0) {
        const d = devs[0];
        setPrinterInfo({ name: d.productName || d.manufacturerName || t("obs.usb.defaultName", lang) });
      }
    });
  }, []);

  const connectPrinter = async () => {
    setPrinterBusy(true);
    try {
      const dev = await requestPrinter();
      if (dev) {
        setPrinterInfo({ name: dev.productName || dev.manufacturerName || t("obs.usb.defaultName", lang) });
        showToast(t("obs.usb.connected.toast", lang), "success");
      }
    } catch (e: any) {
      showToast(e?.message ?? t("obs.usb.connectFail", lang), "error");
    } finally {
      setPrinterBusy(false);
    }
  };

  const testPrinter = async () => {
    setPrinterBusy(true);
    try {
      await printTestPage();
      showToast(t("obs.usb.testSent", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? t("obs.usb.testFail", lang), "error");
    } finally {
      setPrinterBusy(false);
    }
  };

  const storeId = currentUser?.id ?? "";
  const cfg = currentUser?.storeConfig;

  const [restaurantName, setRestaurantName] = useState(currentUser?.restaurantName ?? "");
  const [posVendor, setPosVendor] = useState<PosVendor>((currentUser?.posVendor as PosVendor) ?? "none");
  const [posApiKey, setPosApiKey] = useState(currentUser?.posApiKey ?? "");
  const [foodtech, setFoodtech] = useState(currentUser?.foodtechStoreCode ?? "");
  const vendorInfo = useMemo(() => getVendor(posVendor), [posVendor]);
  const [aligoKey, setAligoKey] = useState(currentUser?.aligoKey ?? "");
  const [aligoUserId, setAligoUserId] = useState(currentUser?.aligoUserId ?? "");
  const [aligoSender, setAligoSender] = useState(currentUser?.aligoSender ?? "");
  const [smsGatewayUrl, setSmsGatewayUrl] = useState(currentUser?.smsGatewayUrl ?? "");

  const [industry, setIndustry] = useState<Industry>(cfg?.industry ?? "general");
  const [rewardType, setRewardType] = useState<RewardType>(cfg?.rewardType ?? "point");
  const [pointRate, setPointRate] = useState(String(cfg?.pointRate ?? 0.05));
  const [stampMax, setStampMax] = useState(String(cfg?.stampMax ?? 10));
  const [inactiveDays, setInactiveDays] = useState(String(cfg?.marketingTriggers?.inactiveDays ?? 30));
  const [birthdayCoupon, setBirthdayCoupon] = useState(!!cfg?.marketingTriggers?.birthdayCoupon);
  // 8-5: 리뷰 작성 보상 쿠폰
  const [reviewCouponOn, setReviewCouponOn] = useState(!!cfg?.reviewCoupon?.enabled);
  const [reviewCouponAmount, setReviewCouponAmount] = useState(String(cfg?.reviewCoupon?.amount ?? ""));
  const [reviewCouponDesc, setReviewCouponDesc] = useState(cfg?.reviewCoupon?.description ?? "");
  const [locationOnly, setLocationOnly] = useState(!!cfg?.locationAccessOnly);
  const [radius, setRadius] = useState(String(cfg?.allowedRadius ?? 100));
  const [tossKey, setTossKey] = useState(cfg?.tossClientKey ?? "");
  const [tossSecret, setTossSecret] = useState(""); // write-only — 보안상 화면에 표시하지 않음
  // 토스플레이스(오프라인 토스 POS) 매출 연동 — merchantId 만 표시값, 키는 write-only
  const [tpMerchantId, setTpMerchantId] = useState(currentUser?.tossPlace?.merchantId ?? "");
  const [tpAccessKey, setTpAccessKey] = useState("");
  const [tpSecretKey, setTpSecretKey] = useState("");
  const [tpWebhookSecret, setTpWebhookSecret] = useState("");
  const [tpBusy, setTpBusy] = useState(false);
  const [kioskEnabled, setKioskEnabled] = useState(!!cfg?.kioskEnabled);
  const [theme, setTheme] = useState(cfg?.theme ?? defaultThemeForIndustry(cfg?.industry));
  // 8-1 / 사이트 — 공개 사이트 글꼴 프리셋 + 부제·주소
  const [fontTheme, setFontTheme] = useState(cfg?.fontTheme ?? "editorial");
  const [tagline, setTagline] = useState(cfg?.tagline ?? "");
  const [address, setAddress] = useState(cfg?.address ?? "");
  // 글꼴 프리셋 미리보기용 — 모든 프리셋 폰트를 1회 로드, 화면 떠날 때 제거(무거운 폰트 잔류 방지)
  useEffect(() => {
    const id = "gyeol-font-preview";
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = googleFontsHref(SITE_FONTS.map((f) => f.google));
      document.head.appendChild(link);
    }
    return () => { document.getElementById(id)?.remove(); };
  }, []);
  // AI 전화 예약 — 가게마다 전화번호·인사말이 다르므로 매장별 설정
  const [aiResEnabled, setAiResEnabled] = useState(!!cfg?.aiReservation?.enabled);
  const [aiResPhone, setAiResPhone] = useState(cfg?.aiReservation?.phoneNumber ?? "");
  const [aiResGreeting, setAiResGreeting] = useState(cfg?.aiReservation?.greeting ?? "");

  const [tierNames, setTierNames] = useState<Record<string, string>>(currentUser?.tierNames ?? {});
  const [tierRewards, setTierRewards] = useState<Record<string, string>>(currentUser?.tierRewards ?? {});

  // 저장값 재동기화 — 비동기 로드/매장 전환/재방문 시 폼이 빈 값·옛 값으로 남던 문제 해결(merchantId 외 전 필드).
  // deps 는 currentUser?.id 뿐 → 같은 매장에서 타이핑/저장 중엔 안 덮어쓰고, 처음 로드되거나 매장이 바뀔 때만 채운다.
  // (write-only 시크릿 입력칸은 의도적으로 제외)
  useEffect(() => {
    if (!currentUser) return;
    const c = currentUser;
    const cf = c.storeConfig;
    setRestaurantName(c.restaurantName ?? "");
    setPosVendor((c.posVendor as PosVendor) ?? "none");
    setPosApiKey(c.posApiKey ?? "");
    setFoodtech(c.foodtechStoreCode ?? "");
    setAligoKey(c.aligoKey ?? "");
    setAligoUserId(c.aligoUserId ?? "");
    setAligoSender(c.aligoSender ?? "");
    setSmsGatewayUrl(c.smsGatewayUrl ?? "");
    setIndustry(cf?.industry ?? "general");
    setRewardType(cf?.rewardType ?? "point");
    setPointRate(String(cf?.pointRate ?? 0.05));
    setStampMax(String(cf?.stampMax ?? 10));
    setInactiveDays(String(cf?.marketingTriggers?.inactiveDays ?? 30));
    setBirthdayCoupon(!!cf?.marketingTriggers?.birthdayCoupon);
    setReviewCouponOn(!!cf?.reviewCoupon?.enabled);
    setReviewCouponAmount(String(cf?.reviewCoupon?.amount ?? ""));
    setReviewCouponDesc(cf?.reviewCoupon?.description ?? "");
    setLocationOnly(!!cf?.locationAccessOnly);
    setRadius(String(cf?.allowedRadius ?? 100));
    setTossKey(cf?.tossClientKey ?? "");
    setKioskEnabled(!!cf?.kioskEnabled);
    setTheme(cf?.theme ?? defaultThemeForIndustry(cf?.industry));
    setFontTheme(cf?.fontTheme ?? "editorial");
    setTagline(cf?.tagline ?? "");
    setAddress(cf?.address ?? "");
    setAiResEnabled(!!cf?.aiReservation?.enabled);
    setAiResPhone(cf?.aiReservation?.phoneNumber ?? "");
    setAiResGreeting(cf?.aiReservation?.greeting ?? "");
    setTierNames(c.tierNames ?? {});
    setTierRewards(c.tierRewards ?? {});
    setTpMerchantId(c.tossPlace?.merchantId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // 언어 설정 — localStorage 기반, 컴포넌트 단위 구독
  const lang = useLanguage();

  if (!currentUser) return null;

  const saveBasic = async () => {
    // 빈 값은 명시적으로 null로 보내 Firestore에서 필드를 비움 (undefined는 merge 시 변경 없음)
    await updateBrandSettings(storeId, {
      restaurantName,
      posVendor,
      posApiKey: (posVendor === "none" ? null : posApiKey) || null,
      foodtechStoreCode: foodtech || null,
      aligoKey: aligoKey || null,
      aligoUserId: aligoUserId || null,
      aligoSender: aligoSender || null,
      smsGatewayUrl: smsGatewayUrl || null,
      tierNames,
      tierRewards,
    } as any);
    showToast(t("obs.ok.basic", lang), "success");
  };

  const saveConfig = async () => {
    // 비율 클램프 (음수·1초과 방지)
    const rate = Math.max(0, Math.min(1, Number(pointRate) || 0));
    const stamps = Math.max(1, Math.min(100, Number(stampMax) || 10));
    const inactive = Math.max(1, Math.min(365, Number(inactiveDays) || 30));
    const r = Math.max(10, Math.min(5000, Number(radius) || 100));

    await updateStoreConfig(storeId, {
      industry,
      rewardType,
      pointRate: rate,
      stampMax: stamps,
      marketingTriggers: { inactiveDays: inactive, birthdayCoupon },
      reviewCoupon: {
        enabled: reviewCouponOn,
        amount: Math.max(0, Number(reviewCouponAmount) || 0),
        description: reviewCouponDesc.trim(),
      },
      locationAccessOnly: locationOnly,
      allowedRadius: r,
      tossClientKey: (tossKey || null) as any,
      kioskEnabled,
      theme,
      fontTheme,
      tagline: tagline.trim(),
      address: address.trim(),
      aiReservation: {
        enabled: aiResEnabled,
        phoneNumber: aiResPhone.replace(/[^\d+]/g, ""), // 숫자·+ 만 — number→storeId 매핑 일관성
        greeting: aiResGreeting.trim(),
      },
    });
    // 시크릿 키 — 입력했을 때만 서버 보안 컬렉션(store_secrets)에 저장. 클라이언트엔 남기지 않음.
    if (tossSecret.trim()) {
      try {
        const res = await fetch(api("/api/store/toss-secret"), {
          method: "POST",
          headers: await authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ storeId, secretKey: tossSecret.trim() }),
        });
        if (res.ok) setTossSecret("");
        else showToast(t("obs.toss.secretFail", lang), "error");
      } catch {
        showToast(t("obs.toss.secretFail", lang), "error");
      }
    }
    // 저장 확정 시점에만 테마를 localStorage 에 영속화 (미리보기는 휘발 — 저장 안 하면 캐시에 안 남음)
    applyTheme(theme, { persist: true });
    // 화면 입력값도 클램프 결과로 정정
    setPointRate(String(rate));
    setStampMax(String(stamps));
    setInactiveDays(String(inactive));
    setRadius(String(r));
    showToast(t("obs.ok.config", lang), "success");
  };

  const captureLocation = async () => {
    try {
      const pos = await getCurrentPosition();
      await updateStoreLocation(storeId, pos.coords.latitude, pos.coords.longitude);
      showToast(t("obs.geo.savedToast", lang, { lat: pos.coords.latitude.toFixed(5), lng: pos.coords.longitude.toFixed(5) }), "success");
    } catch (e: any) {
      showToast(t("obs.geo.fail", lang, { msg: e?.message ?? "" }), "error");
    }
  };

  // 토스플레이스 연동 정보 저장 — 키는 store_secrets(서버 전용)로. 저장 후 키 입력칸은 비움.
  const saveTossPlace = async () => {
    if (!tpMerchantId.trim()) {
      showToast(t("obs.tp.needMerchant", lang), "error");
      return;
    }
    setTpBusy(true);
    try {
      const res = await fetch(api("/api/store/tossplace-config"), {
        method: "POST",
        headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          storeId,
          merchantId: tpMerchantId.trim(),
          accessKey: tpAccessKey.trim() || undefined,
          secretKey: tpSecretKey.trim() || undefined,
          webhookSecret: tpWebhookSecret.trim() || undefined,
        }),
      });
      if (res.ok) {
        setTpAccessKey("");
        setTpSecretKey("");
        setTpWebhookSecret("");
        showToast(t("obs.tp.saved", lang), "success");
      } else {
        showToast(t("obs.tp.saveFail", lang), "error");
      }
    } catch {
      showToast(t("obs.tp.saveFail", lang), "error");
    } finally {
      setTpBusy(false);
    }
  };

  // 웹훅 누락분 수동 동기화/보정 — 오늘 결제를 조회해 매출에 채워넣음.
  const syncTossPlace = async () => {
    setTpBusy(true);
    try {
      const res = await fetch(api("/api/store/tossplace-sync"), {
        method: "POST",
        headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ storeId }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (res.ok && (data.recorded ?? 0) > 0) {
        showToast(t("obs.tp.syncOk", lang, { n: data.recorded }), "success");
      } else if (res.ok) {
        // 0건 진단: 조회수 + 응답 봉투 구조(키 목록)를 그대로 노출 → 주문0건 vs 파싱미스 판별
        const d = data.debug ?? {};
        const diag = `조회 ${data.fetched ?? 0}·기록 0 | top:${(d.topKeys || []).join(",")} | success:${d.successType ?? "?"}${d.successKeys ? "{" + d.successKeys.join(",") + "}" : ""}${d.itemKeys ? " | item:" + d.itemKeys.join(",") : ""}`;
        showToast(diag, "info");
      } else {
        // 진단: 토스 API 응답 status·detail 까지 노출해 실제 원인(401/403/400 + 메시지) 파악
        const detail = `${data.error ?? ""}${data.status ? ` [${data.status}]` : ""}${data.detail ? ` ${String(data.detail).slice(0, 180)}` : ""}`;
        showToast(t("obs.tp.syncFail", lang, { msg: detail }), "error");
      }
    } catch (e: any) {
      showToast(t("obs.tp.syncFail", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setTpBusy(false);
    }
  };

  // 웹훅 진단 — 마지막으로 도착한 토스 웹훅(도착여부·형태·결과)을 확인. "결제했는데 매출 안 늘어남" 원인 파악용.
  const checkTossWebhook = async () => {
    setTpBusy(true);
    try {
      const res = await fetch(api("/api/store/tossplace-diag"), {
        method: "POST",
        headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({} as any));
      const l = data.last;
      if (!l) {
        showToast("아직 도착한 웹훅이 없어요. 토스 웹훅에 '결제' 이벤트가 구독됐는지 확인 후, 결제하고 다시 눌러보세요.", "info");
        return;
      }
      const sig = l.sigOk === true ? "OK" : l.sigOk === false ? "불일치" : "미검증";
      showToast(
        `마지막 웹훅: ${String(l.receivedAt ?? "").slice(0, 19)} · type:${l.type || "(없음)"} · mId:${l.merchantId ?? "?"} · 결과:${l.outcome} · 서명:${sig}${l.topKeys ? ` · keys:${(l.topKeys || []).join(",")}` : ""}`,
        "info"
      );
    } catch (e: any) {
      showToast("웹훅 진단 실패: " + (e?.message ?? ""), "error");
    } finally {
      setTpBusy(false);
    }
  };

  // 토스플레이스 콘솔에 등록할 웹훅 수신 주소 (VITE_API_URL 미설정 시 현재 출처 기준)
  const tossPlaceWebhookUrl = (() => {
    const u = api("/api/tossplace/webhook");
    return u.startsWith("http") ? u : `${window.location.origin}${u}`;
  })();

  return (
    <OwnerShell title={t("obs.title", lang)} width="narrow">
      <div className="pb-12">
        <Sec title={t("obs.sec.basic", lang)} group={t("obs.group.basic", lang)}>
          <Input label={t("obs.field.storeName", lang)} value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} />
        </Sec>

        <Sec title={t("obs.sec.language", lang)} defaultOpen={false}>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-[var(--color-navy-50)] inline-flex items-center justify-center flex-shrink-0">
              <Languages className="w-5 h-5 text-[var(--color-navy-700)]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-[var(--color-navy-900)]">{t("obs.lang.title", lang)}</p>
              <p className="text-[12px] text-[var(--color-ink-500)] font-medium mt-0.5 break-keep">
                {t("obs.lang.desc", lang)}
              </p>
              <div className="flex gap-2 mt-3 flex-wrap">
                {LANGS.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => setLanguage(l.code)}
                    className={`h-10 px-4 rounded-full border text-[13px] font-bold ${
                      lang === l.code
                        ? "bg-[var(--color-navy-700)] text-white border-transparent"
                        : "bg-white text-[var(--color-ink-700)] border-[var(--color-line)]"
                    }`}
                  >
                    {l.native}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Sec>

        <Sec title={t("obs.sec.pos", lang)} group={t("obs.group.ops", lang)} defaultOpen={false}>
          <div>
            <label className="block text-[13px] font-semibold text-[var(--color-navy-800)] mb-2">
              {t("obs.pos.using", lang)}
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
              label={t("obs.pos.apiKeyOption", lang, { label: vendorInfo.keyLabel ?? t("obs.pos.apiLabel", lang) })}
              placeholder={vendorInfo.placeholder ?? t("obs.pos.placeholderDefault", lang)}
              value={posApiKey}
              onChange={(e) => setPosApiKey(e.target.value)}
              leftSlot={<KeyRound className="w-4 h-4" />}
              hint={
                posApiKey
                  ? vendorInfo.hint ?? t("obs.pos.hintAuto", lang)
                  : t("obs.pos.hintNoKey", lang)
              }
            />
          ) : (
            <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]">
              <Info className="w-4 h-4 text-[var(--color-mint-700)] mt-0.5 shrink-0" />
              <p className="text-[12px] text-[var(--color-mint-700)] font-semibold leading-relaxed">
                {vendorInfo.hint ?? t("obs.pos.hintNone", lang)}
              </p>
            </div>
          )}

          <Input
            label={t("obs.pos.legacy", lang)}
            value={foodtech}
            onChange={(e) => setFoodtech(e.target.value)}
            hint={t("obs.pos.legacyHint", lang)}
          />
        </Sec>

        {/* ===== USB 영수증 프린터 직결 ===== */}
        <Sec title={t("obs.sec.printerUsb", lang)} defaultOpen={false}>
          {!isWebUsbSupported() ? (
            <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[#fef2f2] border border-[var(--color-danger)]/30">
              <AlertCircle className="w-4 h-4 text-[var(--color-danger)] mt-0.5 shrink-0" />
              <p className="text-[12px] text-[var(--color-danger)] font-semibold leading-relaxed">
                {t("obs.usb.unsupported", lang)}
                <br />
                <span className="font-medium opacity-90">
                  {t("obs.usb.unsupportedDesc", lang)}
                </span>
              </p>
            </div>
          ) : printerInfo ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]">
                <CheckCircle2 className="w-4 h-4 text-[var(--color-mint-700)] mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-bold text-[var(--color-mint-700)]">
                    {printerInfo.name}
                  </p>
                  <p className="text-[12px] text-[var(--color-mint-700)] font-medium opacity-90 mt-0.5">
                    {t("obs.usb.connected", lang)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={testPrinter}
                  loading={printerBusy}
                  leftIcon={<Printer className="w-4 h-4" />}
                >
                  {t("obs.usb.testPrint", lang)}
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  onClick={connectPrinter}
                  loading={printerBusy}
                  leftIcon={<Plug className="w-4 h-4" />}
                >
                  {t("obs.usb.pickOther", lang)}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[var(--color-navy-50)] border border-[var(--color-navy-200)]">
                <Info className="w-4 h-4 text-[var(--color-navy-700)] mt-0.5 shrink-0" />
                <p className="text-[12px] text-[var(--color-navy-700)] font-semibold leading-relaxed">
                  {t("obs.usb.intro", lang)}
                  <br />
                  <span className="font-medium opacity-90">
                    {t("obs.usb.persistent", lang)}
                  </span>
                </p>
              </div>
              <Button
                block
                onClick={connectPrinter}
                loading={printerBusy}
                leftIcon={<Plug className="w-4 h-4" />}
              >
                {t("obs.usb.connect", lang)}
              </Button>
            </div>
          )}
        </Sec>

        {/* ===== 영업 시간 ===== */}
        <BusinessHoursSection
          owner={currentUser}
          onSave={async (patch) => {
            await updateBrandSettings(storeId, patch);
            showToast(t("obs.ok.hours", lang), "success");
          }}
        />

        {/* ===== 영수증 자동 인쇄 (브릿지) — 옵션 B ===== */}
        <PrintBridgeSection
          storeId={storeId}
          ownerName={currentUser.restaurantName}
          enabled={!!currentUser.printBridgeEnabled}
          device={currentUser.printBridgeDevice}
          onToggle={async (v) => {
            await updateBrandSettings(storeId, { printBridgeEnabled: v });
            showToast(v ? t("obs.ok.bridgeOn", lang) : t("obs.ok.bridgeOff", lang), "success");
          }}
        />

        {/* ===== 푸시 알림 — 사장님 폰/PC 로 새 주문·결제 요청·직원 가입 알림 ===== */}
        <PushNotificationSection
          storeId={storeId}
          prefs={currentUser.pushPrefs}
          deviceCount={(currentUser.fcmTokens ?? []).length}
          onPrefChange={async (patch) => {
            await updateBrandSettings(storeId, {
              pushPrefs: { ...(currentUser.pushPrefs ?? {}), ...patch },
            });
          }}
        />

        <Sec title={t("obs.sec.industry", lang)} group={t("obs.group.design", lang)}>
          <div className="grid grid-cols-4 gap-2">
            {(["cafe", "meat", "bakery", "general"] as Industry[]).map((i) => (
              <Pill key={i} active={industry === i} onClick={() => setIndustry(i)}>
                {i === "cafe" ? t("obs.industry.cafe", lang) : i === "meat" ? t("obs.industry.meat", lang) : i === "bakery" ? t("obs.industry.bakery", lang) : t("obs.industry.general", lang)}
              </Pill>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            {(["point", "stamp"] as RewardType[]).map((r) => (
              <Pill key={r} active={rewardType === r} onClick={() => setRewardType(r)}>
                {r === "point" ? t("obs.reward.point", lang) : t("obs.reward.stamp", lang)}
              </Pill>
            ))}
          </div>
          {rewardType === "point" ? (
            <Input
              label={t("obs.field.pointRate", lang)}
              value={pointRate}
              onChange={(e) => setPointRate(e.target.value)}
              hint={t("obs.field.pointRateHint", lang)}
            />
          ) : (
            <Input
              label={t("obs.field.stampMax", lang)}
              value={stampMax}
              onChange={(e) => setStampMax(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
            />
          )}
        </Sec>

        <Sec title={t("obs.sec.theme", lang)}>
          <p className="text-[12px] text-[var(--color-ink-500)] -mt-1 mb-1 leading-relaxed break-keep">
            {t("obs.theme.desc", lang)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((th) => {
              const active = theme === th.id;
              const recommended = th.recommendedFor?.includes(industry);
              return (
                <button
                  key={th.id}
                  type="button"
                  onClick={() => {
                    setTheme(th.id);
                    applyTheme(th.id); // 즉시 미리보기 (저장 전)
                  }}
                  className={cn(
                    "relative text-left p-3 rounded-[14px] border-2 transition-all active:scale-[0.98]",
                    active
                      ? "border-[var(--color-navy-700)] shadow-[var(--shadow-card)]"
                      : "border-[var(--color-line)] bg-white"
                  )}
                >
                  {recommended && (
                    <span className="absolute top-1.5 right-1.5 text-[9.5px] font-extrabold px-1.5 py-0.5 rounded-full bg-[var(--color-mint-100)] text-[var(--color-mint-700)]">
                      {t("obs.theme.recommend", lang)}
                    </span>
                  )}
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span
                      className="w-5 h-5 rounded-full border border-black/5 shrink-0"
                      style={{ background: th.primary }}
                    />
                    <span
                      className="w-5 h-5 rounded-full border border-black/5 shrink-0 -ml-2.5"
                      style={{ background: th.accent }}
                    />
                    <span className="text-[16px] ml-0.5">{th.emoji}</span>
                  </div>
                  <p className="text-[13px] font-extrabold text-[var(--color-navy-900)] flex items-center gap-1">
                    {th.name}
                    {active && <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-navy-700)]" />}
                  </p>
                  <p className="text-[10.5px] text-[var(--color-ink-500)] font-medium leading-snug mt-0.5 break-keep">
                    {th.desc}
                  </p>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-[var(--color-ink-400)] font-medium mt-1">
            {t("obs.theme.saveHint", lang)}
          </p>
        </Sec>

        <Sec title={t("obs.sec.siteBrand", lang)}>
          {/* 8-1: 공개 사이트 글꼴 프리셋 */}
          <div>
            <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1.5 block">{t("obs.font.label", lang)}</label>
            <div className="grid grid-cols-2 gap-2">
              {SITE_FONTS.map((f) => {
                const active = fontTheme === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFontTheme(f.id)}
                    className={`rounded-xl border p-3 text-left transition-colors ${active ? "border-[var(--color-navy-700)] bg-[var(--color-navy-50)] ring-1 ring-[var(--color-navy-700)]" : "border-[var(--color-line)] bg-white"}`}
                  >
                    <p className="text-[20px] text-[var(--color-navy-900)] leading-none" style={{ fontFamily: f.display }}>{t("obs.font.sample", lang)}</p>
                    <p className="text-[11.5px] text-[var(--color-ink-500)] mt-1.5">{t(f.nameKey, lang)}</p>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-[var(--color-ink-400)] mt-1.5 leading-relaxed">{t("obs.font.hint", lang)}</p>
          </div>
          <Input label={t("obs.site.tagline", lang)} value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder={t("obs.site.taglinePh", lang)} />
          <Input label={t("obs.site.address", lang)} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t("obs.site.addressPh", lang)} />
        </Sec>

        <Sec title={t("obs.sec.tierCustom", lang)} group={t("obs.group.marketing", lang)} defaultOpen={false}>
          <div className="space-y-2">
            {TIER_ORDER.map((tier) => (
              <Card key={tier} padding="sm">
                <p className="text-[12px] font-bold text-[var(--color-navy-700)] mb-2">{tier}</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    placeholder={t("obs.tier.aliasPh", lang)}
                    value={tierNames[tier] ?? ""}
                    onChange={(e) => setTierNames({ ...tierNames, [tier]: e.target.value })}
                    className="input-field text-[13px]"
                  />
                  <input
                    placeholder={t("obs.tier.rewardPh", lang)}
                    value={tierRewards[tier] ?? ""}
                    onChange={(e) => setTierRewards({ ...tierRewards, [tier]: e.target.value })}
                    className="input-field text-[13px]"
                  />
                </div>
              </Card>
            ))}
          </div>
        </Sec>

        <Sec title={t("obs.sec.marketing", lang)}>
          <Input
            label={t("obs.marketing.inactive", lang)}
            value={inactiveDays}
            onChange={(e) => setInactiveDays(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
          />
          <Toggle label={t("obs.marketing.birthday", lang)} value={birthdayCoupon} onChange={setBirthdayCoupon} />
          {/* 8-5: 리뷰 작성 보상 쿠폰 */}
          <div className="pt-3 mt-3 border-t border-[var(--color-line-soft)] space-y-2">
            <Toggle label={t("obs.marketing.reviewCoupon", lang)} value={reviewCouponOn} onChange={setReviewCouponOn} />
            {reviewCouponOn && (
              <>
                <Input
                  label={t("obs.marketing.reviewCouponAmount", lang)}
                  value={reviewCouponAmount}
                  onChange={(e) => setReviewCouponAmount(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  placeholder="0"
                />
                <Input
                  label={t("obs.marketing.reviewCouponDesc", lang)}
                  value={reviewCouponDesc}
                  onChange={(e) => setReviewCouponDesc(e.target.value)}
                  placeholder={t("obs.marketing.reviewCouponDescPh", lang)}
                />
                <p className="text-[11px] text-[var(--color-ink-500)] leading-relaxed">{t("obs.marketing.reviewCouponHint", lang)}</p>
              </>
            )}
          </div>
        </Sec>

        <Sec title={t("obs.sec.sms", lang)} defaultOpen={false}>
          <Input label={t("obs.sms.aligoKey", lang)} value={aligoKey} onChange={(e) => setAligoKey(e.target.value)} />
          <Input label={t("obs.sms.aligoUserId", lang)} value={aligoUserId} onChange={(e) => setAligoUserId(e.target.value)} />
          <Input label={t("obs.sms.sender", lang)} value={aligoSender} onChange={(e) => setAligoSender(e.target.value)} />
          <Input label={t("obs.sms.gateway", lang)} value={smsGatewayUrl} onChange={(e) => setSmsGatewayUrl(e.target.value)} />
        </Sec>

        <Sec title={t("obs.sec.payment", lang)} group={t("obs.group.payment", lang)} defaultOpen={false}>
          <Input label={t("obs.payment.toss", lang)} value={tossKey} onChange={(e) => setTossKey(e.target.value)} />
          <Input
            label={t("obs.payment.tossSecret", lang)}
            type="password"
            value={tossSecret}
            onChange={(e) => setTossSecret(e.target.value)}
            placeholder={t("obs.payment.tossSecretPh", lang)}
          />
          <p className="text-[12px] text-[var(--color-ink-500)] mt-1 leading-relaxed">
            {t("obs.payment.tossSecretHelp", lang)}
          </p>
        </Sec>

        <Sec title={t("obs.sec.tossplace", lang)} defaultOpen={false}>
          <div className="flex items-start gap-2 p-3.5 rounded-[14px] bg-[var(--color-navy-50)] border border-[var(--color-navy-200)]">
            <Info className="w-4 h-4 text-[var(--color-navy-700)] mt-0.5 shrink-0" />
            <p className="text-[12px] text-[var(--color-navy-700)] font-semibold leading-relaxed">
              {t("obs.tp.desc", lang)}
            </p>
          </div>

          {currentUser.tossPlace?.connectedAt && (
            <div className="flex items-center gap-2 p-3 rounded-[12px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)]">
              <CheckCircle2 className="w-4 h-4 text-[var(--color-mint-700)] shrink-0" />
              <p className="text-[12px] text-[var(--color-mint-700)] font-bold">
                {t("obs.tp.connected", lang, { id: currentUser.tossPlace.merchantId ?? "" })}
              </p>
            </div>
          )}

          <Input
            label={t("obs.tp.merchantId", lang)}
            value={tpMerchantId}
            onChange={(e) => setTpMerchantId(e.target.value)}
            placeholder="merchant_..."
            leftSlot={<KeyRound className="w-4 h-4" />}
          />
          <Input
            label={t("obs.tp.accessKey", lang)}
            value={tpAccessKey}
            onChange={(e) => setTpAccessKey(e.target.value)}
            placeholder={t("obs.tp.changeOnly", lang)}
          />
          <Input
            label={t("obs.tp.secretKey", lang)}
            type="password"
            value={tpSecretKey}
            onChange={(e) => setTpSecretKey(e.target.value)}
            placeholder={t("obs.tp.changeOnly", lang)}
          />
          <Input
            label={t("obs.tp.webhookSecret", lang)}
            type="password"
            value={tpWebhookSecret}
            onChange={(e) => setTpWebhookSecret(e.target.value)}
            placeholder={t("obs.tp.changeOnly", lang)}
          />

          <div>
            <label className="block text-[13px] font-semibold text-[var(--color-navy-800)] mb-1">
              {t("obs.tp.webhookUrl", lang)}
            </label>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(tossPlaceWebhookUrl);
                showToast(t("obs.tp.copied", lang), "info");
              }}
              className="w-full text-left px-3 py-2.5 rounded-[12px] bg-[var(--color-ink-50)] border border-[var(--color-line)] text-[12px] font-mono text-[var(--color-ink-700)] break-all active:scale-[0.99] transition-transform"
            >
              {tossPlaceWebhookUrl}
            </button>
            <p className="text-[11.5px] text-[var(--color-ink-500)] mt-1 leading-relaxed">
              {t("obs.tp.webhookHelp", lang)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button onClick={saveTossPlace} loading={tpBusy} leftIcon={<Save className="w-4 h-4" />}>
              {t("obs.tp.save", lang)}
            </Button>
            <Button variant="outline" onClick={syncTossPlace} loading={tpBusy} leftIcon={<Plug className="w-4 h-4" />}>
              {t("obs.tp.syncNow", lang)}
            </Button>
          </div>
          <Button variant="ghost" onClick={checkTossWebhook} loading={tpBusy} className="w-full text-[12px] text-[var(--color-ink-600)]">
            🔎 웹훅 수신 확인 (결제했는데 안 늘어날 때)
          </Button>
        </Sec>

        <Sec title={t("obs.sec.kiosk", lang)} group={t("obs.group.extra", lang)} defaultOpen={false}>
          <Toggle label={t("obs.kiosk.enable", lang)} value={kioskEnabled} onChange={setKioskEnabled} />
          <p className="text-[12px] text-[var(--color-ink-500)] mt-2 leading-relaxed">{t("obs.kiosk.desc", lang)}</p>
        </Sec>

        <Sec title={t("obs.sec.aiPhone", lang)} defaultOpen={false}>
          <Toggle label={t("obs.aiPhone.enable", lang)} value={aiResEnabled} onChange={setAiResEnabled} />
          <p className="text-[12px] text-[var(--color-ink-500)] mt-2 mb-3 leading-relaxed">{t("obs.aiPhone.desc", lang)}</p>
          {aiResEnabled && (
            <>
              <Input
                label={t("obs.aiPhone.number", lang)}
                value={aiResPhone}
                onChange={(e) => setAiResPhone(e.target.value)}
                inputMode="tel"
                placeholder="010-1234-5678"
              />
              <p className="text-[12px] text-[var(--color-ink-500)] mt-1 mb-3 leading-relaxed">{t("obs.aiPhone.numberHelp", lang)}</p>
              <Input
                label={t("obs.aiPhone.greeting", lang)}
                value={aiResGreeting}
                onChange={(e) => setAiResGreeting(e.target.value)}
                placeholder={t("obs.aiPhone.greetingPh", lang)}
              />
            </>
          )}
        </Sec>

        <Sec title={t("obs.sec.geo", lang)} defaultOpen={false}>
          <Toggle label={t("obs.geo.only", lang)} value={locationOnly} onChange={setLocationOnly} />
          <Input
            label={t("obs.geo.radius", lang)}
            value={radius}
            onChange={(e) => setRadius(e.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
          />
          <Button variant="ghost" size="md" onClick={captureLocation} leftIcon={<MapPin className="w-4 h-4" />} block>
            {t("obs.geo.save", lang)}
          </Button>
          {currentUser.lat && currentUser.lng && (
            <p className="text-[12px] text-[var(--color-ink-600)] mt-1.5 tabular-nums">
              {t("obs.geo.saved", lang, { lat: currentUser.lat.toFixed(5), lng: currentUser.lng.toFixed(5) })}
            </p>
          )}
        </Sec>

        <div className="grid grid-cols-2 gap-3 mt-6 sticky bottom-4">
          <Button variant="ghost" size="lg" onClick={saveBasic} leftIcon={<Save className="w-4 h-4" />}>
            {t("obs.saveBasic", lang)}
          </Button>
          <Button size="lg" onClick={saveConfig} leftIcon={<Save className="w-4 h-4" />}>
            {t("obs.saveConfig", lang)}
          </Button>
        </div>
      </div>
    </OwnerShell>
  );
}


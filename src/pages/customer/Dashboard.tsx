import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Ticket, User as UserIcon, LogOut, Trash2, Sparkles, UtensilsCrossed, Plus, ShoppingBag, CreditCard, Receipt as ReceiptIcon, DoorOpen, Store, ChevronRight } from "lucide-react";
import { LANGS, useLanguage, setLanguage, t, fmtKRW, getLocale } from "../../lib/i18n";
import { MobileShell } from "../../components/layout/MobileShell";
import { TopBar } from "../../components/ui/TopBar";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { BillModal } from "../../components/ui/BillModal";
import { OptionPickerModal } from "../../components/order/OptionPickerModal";
import { useStore } from "../../store/store";
import { getEffectiveTier, getNextTier } from "../../lib/tier";
import { cn } from "../../lib/cn";
import { showToast } from "../../lib/toast";
import { startCardPayment } from "../../lib/tossPayments";
import type { Menu, SelectedOption } from "../../lib/types";
import { getStoreOpenStatus } from "../../lib/businessHours";
import { StoreStatusBanner } from "./dashboard/StoreStatusBanner";
import { PastVisitsCard } from "./dashboard/PastVisitsCard";
import { CouponRow } from "./dashboard/CouponRow";
import { SessionTimer, SmallStat, Info, QtyStepper } from "./dashboard/widgets";
import { OrderProgress, OrderStatusPill } from "./dashboard/OrderProgress";
import { ReviewModal } from "./dashboard/ReviewModal";
import { BottomNav } from "./dashboard/BottomNav";
import type { Tab } from "./dashboard/types";


interface CartLine {
  menuId: string;
  qty: number;
  selectedOptions: SelectedOption[];
  unitPrice: number; // 옵션 반영 단가
}
// 같은 메뉴라도 옵션이 다르면 다른 라인. 옵션 없으면 키=menuId (기존 +/- 동작 유지)
const lineKey = (menuId: string, opts: SelectedOption[]) =>
  opts.length === 0 ? menuId : `${menuId}|${opts.map((o) => o.optionId).slice().sort().join(",")}`;
const optSummary = (opts: SelectedOption[]) => opts.map((o) => o.optionName).join(" · ");

export default function CustomerDashboard() {
  const { storeId: paramStoreId } = useParams();
  const [searchParams] = useSearchParams();
  const tableParam = searchParams.get("table");
  const nav = useNavigate();
  const {
    currentUser,
    users,
    visits,
    coupons,
    tables,
    tierOverrides,
    menus,
    orders,
    logout,
    deleteAccount,
    requestCouponUse,
    cancelCouponRequest,
    issueCoupon,
    placeOrder,
    payTableSession,
    addPhoto,
    setActiveStoreId,
    enterTable,
    leaveTable,
  } = useStore();
  const [tab, setTab] = useState<Tab>("home");
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [picker, setPicker] = useState<Menu | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // 언어 변경 시 상위 리렌더 — 프로필 탭의 언어 선택 버튼에서 사용
  const lang = useLanguage();

  // 이 페이지에 있는 동안 해당 매장의 tables/menus/orders/photos 구독
  // 페이지 떠나도 테이블 점유는 유지 — 명시적 '가게 퇴장' 또는 사장님 강제 퇴장만 점유 해제.
  useEffect(() => {
    setActiveStoreId(paramStoreId ?? null);
    // 매장이 바뀌면 카트도 비움 (이전 매장 메뉴 ID는 새 매장에서 무효)
    setCart({});
    return () => setActiveStoreId(null);
  }, [paramStoreId, setActiveStoreId]);

  // QR 로 ?table=N 받아 진입한 경우 — 자리 점유 자동 등록(합석 가능)
  useEffect(() => {
    if (!currentUser || !paramStoreId) return;
    const n = Number(tableParam);
    if (!Number.isFinite(n) || n <= 0) return;
    enterTable({
      tableNumber: n,
      storeId: paramStoreId,
      customerId: currentUser.id,
      customerName: currentUser.name,
    }).catch((e) => console.warn("[enterTable]", e?.message));
    // tableParam 이 같은 한 다시 호출되어도 합석 occupantIds 만 갱신 → 안전
  }, [tableParam, paramStoreId, currentUser?.id]);

  const handleExitStore = async () => {
    if (!currentUser) return;
    const tableNum = myTable?.number;
    if (!tableNum) {
      // 점유한 테이블이 없으면 그냥 홈으로
      nav("/customer", { replace: true });
      return;
    }
    if (!window.confirm(t("home.leaveConfirm"))) return;
    try {
      await leaveTable(tableNum, paramStoreId ?? "");
      showToast(t("home.leaveToast"), "success");
      nav("/customer", { replace: true });
    } catch (e: any) {
      showToast(t("home.leaveFail", undefined, { msg: e?.message ?? "" }), "error");
    }
  };

  const storeId = paramStoreId ?? "";
  const owner = users.find((u) => u.id === storeId && u.role === "owner");

  // 잘못된 storeId 진입 가드 (users 로드 후 3회 재시도 후 홈으로)
  const [ownerCheck, setOwnerCheck] = useState(0);
  useEffect(() => {
    if (!storeId || owner) return;
    if (users.length === 0) return; // 아직 로드 중
    if (ownerCheck < 3) {
      const t = setTimeout(() => setOwnerCheck((n) => n + 1), 400);
      return () => clearTimeout(t);
    }
    showToast(t("home.storeNotFound"), "error");
    nav("/customer", { replace: true });
  }, [storeId, owner, users.length, ownerCheck, nav]);

  const myVisits = useMemo(
    () => visits.filter((v) => v.customerId === currentUser?.id && v.storeId === storeId)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [visits, currentUser?.id, storeId]
  );
  const myCoupons = useMemo(
    () => coupons.filter((c) => c.customerId === currentUser?.id && c.storeId === storeId)
      .sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime()),
    [coupons, currentUser?.id, storeId]
  );

  // 8-6: 새 쿠폰 도착 알림 — 고객 FCM 푸시가 없어 인앱 실시간 알림(토스트 + 탭 뱃지)으로.
  //  · localStorage 의 '본 쿠폰' 집합과 비교해, 지난 세션 후/실시간으로 새로 온 쿠폰만 알림.
  //  · 24h 이내 발급분만 알려 옛 쿠폰·첫 로드 오탐을 방지.
  const [unseenCoupons, setUnseenCoupons] = useState(0);
  useEffect(() => {
    const uid = currentUser?.id;
    if (!uid || !storeId) return;
    const key = `gyeol:coupons-seen:${storeId}:${uid}`;
    const raw = localStorage.getItem(key);
    const avail = myCoupons.filter((c) => c.status !== "used");
    // 최초 진입(키 없음)이면: 기존 쿠폰을 조용히 baseline 으로만 기록(토스트·뱃지 X). 첫 로드 오탐 방지.
    if (raw === null) {
      if (avail.length) localStorage.setItem(key, JSON.stringify(avail.map((c) => c.id)));
      return;
    }
    let stored: Set<string>;
    try { stored = new Set<string>(JSON.parse(raw)); } catch { stored = new Set(); }
    // baseline 이후 새로 온(seen 에 없는) 쿠폰은 24h 컷 없이 알림 — 오래 안 들어온 손님도 도착 알림 수신
    const fresh = avail.filter((c) => !stored.has(c.id));
    if (fresh.length) {
      showToast(t("coupons.arrived", lang), "success");
      setUnseenCoupons((n) => n + fresh.length);
    }
    if (avail.length) {
      avail.forEach((c) => stored.add(c.id));
      localStorage.setItem(key, JSON.stringify([...stored]));
    }
  }, [myCoupons, currentUser?.id, storeId, lang]);
  useEffect(() => { if (tab === "coupons") setUnseenCoupons(0); }, [tab]);
  const myTable = useMemo(
    () => tables.find((t) => t.currentCustomerId === currentUser?.id && t.storeId === storeId),
    [tables, currentUser?.id, storeId]
  );
  const storeMenus = useMemo(
    () => menus.filter((m) => m.storeId === storeId && m.isAvailable !== false),
    [menus, storeId]
  );
  const menuByCat = useMemo(() => {
    const map: Record<string, typeof storeMenus> = {};
    for (const m of storeMenus) (map[m.category] ??= []).push(m);
    return map;
  }, [storeMenus]);
  // 본 매장 본인의 모든 주문 (취소 제외)
  const allMyOrders = useMemo(
    () =>
      orders
        .filter(
          (o) =>
            o.customerId === currentUser?.id &&
            o.storeId === storeId &&
            o.status !== "cancelled"
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [orders, currentUser?.id, storeId]
  );

  /**
   * 세션 분리 — 손님이 한 매장에 여러 번 방문 시 '이번 방문' / '지난 방문' 명확 구분.
   *
   * 기준: myTable.sessionStartTime 이 있으면 그 시각 이후 주문만 '현재 세션'.
   *       없으면 미결제(unpaid/requested) 가 있는 시점부터 현재 세션으로 폴백.
   *       그 외 결제 완료된 과거 주문은 '지난 방문 영수증'.
   */
  const sessionStartIso = myTable?.sessionStartTime ?? null;
  const mySessionOrders = useMemo(() => {
    if (sessionStartIso) {
      return allMyOrders.filter((o) => o.createdAt >= sessionStartIso);
    }
    // 점유 정보 없으면 — 미결제 주문만 현재 세션으로
    const hasUnpaid = allMyOrders.some((o) => o.paymentStatus !== "paid");
    if (!hasUnpaid) return [];
    // 가장 오래된 미결제 이후 모든 주문
    const oldest = allMyOrders.find((o) => o.paymentStatus !== "paid");
    return oldest ? allMyOrders.filter((o) => o.createdAt >= oldest.createdAt) : [];
  }, [allMyOrders, sessionStartIso]);

  /** 지난 방문 = 현재 세션에 포함 안 된 결제 완료 주문 — 날짜별 그룹 */
  const pastVisits = useMemo(() => {
    const sessionIds = new Set(mySessionOrders.map((o) => o.id));
    const past = allMyOrders.filter((o) => !sessionIds.has(o.id) && o.paymentStatus === "paid");
    // 날짜(YYYY-MM-DD) 별로 그룹 + 같은 날 합산
    const map = new Map<string, { date: string; orders: typeof past; total: number; itemsCount: number }>();
    past.forEach((o) => {
      const d = o.createdAt.slice(0, 10);
      const g = map.get(d) ?? { date: d, orders: [], total: 0, itemsCount: 0 };
      g.orders.push(o);
      g.total += o.totalAmount;
      g.itemsCount += o.items.reduce((s, it) => s + it.quantity, 0);
      map.set(d, g);
    });
    // 최신순
    return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [allMyOrders, mySessionOrders]);

  const myActiveOrder = useMemo(
    () => mySessionOrders.find((o) => o.status !== "served"),
    [mySessionOrders]
  );
  const unpaidOrders = useMemo(
    () => mySessionOrders.filter((o) => o.paymentStatus !== "paid"),
    [mySessionOrders]
  );
  const unpaidTotal = unpaidOrders.reduce((s, o) => s + o.totalAmount, 0);

  const cartItems = Object.entries(cart)
    .map(([key, line]) => {
      const m = storeMenus.find((x) => x.id === line.menuId);
      // 메뉴가 사라졌거나(삭제) isAvailable=false 면 카트에서 제외
      if (!m || m.isAvailable === false) return null;
      return { key, menu: m, qty: line.qty, selectedOptions: line.selectedOptions, unitPrice: line.unitPrice };
    })
    .filter(Boolean) as { key: string; menu: (typeof storeMenus)[number]; qty: number; selectedOptions: SelectedOption[]; unitPrice: number }[];
  const cartTotal = cartItems.reduce((s, c) => s + c.unitPrice * c.qty, 0);
  const cartCount = cartItems.reduce((s, c) => s + c.qty, 0);
  const menuInCart = (menuId: string) => cartItems.filter((c) => c.menu.id === menuId).reduce((s, c) => s + c.qty, 0);

  // 사장님이 메뉴를 품절/삭제한 항목이 있으면 알림 후 cart 정리.
  // useRef 로 1회만 알림 — 매 렌더 토스트 폭주 방지.
  const removedCartIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const aliveMenuIds = new Set(cartItems.map((c) => c.menu.id));
    const removed = Object.entries(cart).filter(([key, line]) => !aliveMenuIds.has(line.menuId) && !removedCartIdsRef.current.has(key));
    if (removed.length > 0) {
      removed.forEach(([key]) => removedCartIdsRef.current.add(key));
      showToast(t("home.cart.soldOut", lang), "info");
      // cart 에서도 제거 — 다음 submitOrder 시 0건이 되지 않게
      setCart((c) => {
        const next = { ...c };
        for (const [key] of removed) delete next[key];
        return next;
      });
    }
  // cartItems 는 매 렌더 새 array — 라인 key 의 set 만 비교
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(cart).join(","), cartItems.map((c) => c.key).join(",")]);

  const submitOrder = async () => {
    if (!currentUser || !myTable || cartItems.length === 0) return;
    // 영업 외 시간 사전 차단 — store.placeOrder 도 검증하지만 사용자 경험 위해 UI 에서도 한 번
    const s = getStoreOpenStatus(owner);
    if (s.open === false) {
      showToast(t("menu.orderFailReason", undefined, { reason: s.reason }), "error");
      return;
    }
    try {
      await placeOrder({
        storeId,
        tableNumber: myTable.number,
        customerId: currentUser.id,
        items: cartItems.map((c) => ({
          menuId: c.menu.id,
          name: c.menu.name,
          quantity: c.qty,
          price: c.unitPrice,
          ...(c.selectedOptions.length ? { selectedOptions: c.selectedOptions } : {}),
        })),
      });
    } catch (e: any) {
      // store 에서 영업 외·강제 퇴장·금액 검증 실패 throw 한 경우 toast 는 store 에서 표시됨
      // 강제 퇴장 케이스는 추가로 매장 홈으로 이동
      if (String(e?.message ?? "").includes("table not occupied")) {
        nav("/customer", { replace: true });
      }
      return;
    }
    setCart({});
    setCartOpen(false);
    setTab("home");
  };

  // 옵션 라인 추가/병합 — 같은 메뉴+같은 옵션이면 수량+1
  const onPickerConfirm = (opts: SelectedOption[], unitPrice: number) => {
    if (!picker) return;
    const key = lineKey(picker.id, opts);
    const menuId = picker.id;
    setCart((c) => {
      const existing = c[key];
      return { ...c, [key]: existing ? { ...existing, qty: existing.qty + 1 } : { menuId, qty: 1, selectedOptions: opts, unitPrice } };
    });
    setPicker(null);
    showToast(t("cart.added", lang), "success");
  };
  const setLineQty = (key: string, v: number) =>
    setCart((c) => {
      const next = { ...c };
      if (v <= 0) delete next[key];
      else if (next[key]) next[key] = { ...next[key], qty: v };
      return next;
    });

  const handlePay = () => {
    if (!currentUser || !myTable) return;
    if (unpaidTotal === 0) return;
    // 결제 요청 전에 리뷰(사진+별점+글) 모달을 띄움 — 건너뛰기 가능
    setReviewOpen(true);
  };

  const submitPaymentWithReview = async (
    review?: { rating?: number; reviewText?: string; imageData?: string }
  ) => {
    if (!currentUser || !myTable) return;
    setReviewOpen(false);
    try {
      // 리뷰 내용이 하나라도 있으면 photos 컬렉션에 type="review"로 저장
      const hasReview = !!(review && (review.rating || review.reviewText?.trim() || review.imageData));
      if (hasReview) {
        await addPhoto({
          storeId,
          type: "review",
          ...(review!.imageData ? { imageData: review!.imageData } : {}),
          ...(review!.rating ? { rating: review!.rating } : {}),
          ...(review!.reviewText?.trim() ? { reviewText: review!.reviewText.trim() } : {}),
          customerId: currentUser.id,
          customerName: currentUser.name,
          tableNumber: myTable.number,
        });
        // 8-5: 리뷰 작성 보상 쿠폰 — 매장이 켰고 실제 리뷰(별점/글)면 자동 지급. 도착 알림은 8-6이 처리.
        //  · 이번 방문(세션)에 이미 'review' 쿠폰을 받았으면 중복 지급 안 함. used 만 검사하면
        //    쿠폰을 pending/used 로 만든 뒤 모달 재오픈으로 누적 발급되는 악용이 가능해, 세션 기준으로 차단.
        const rc = owner?.storeConfig?.reviewCoupon;
        const realReview = !!(review!.rating || review!.reviewText?.trim());
        const sessionStart = myTable.sessionStartTime ?? "";
        const alreadyHas = coupons.some(
          (c) =>
            c.customerId === currentUser.id && c.storeId === storeId && c.type === "review" &&
            // status 무관 — 이번 세션(sessionStart 이후) 발급분이 하나라도 있으면 재발급 차단(used 로 만든 뒤 재오픈 악용 방지)
            (!sessionStart || (c.issuedAt ?? "") >= sessionStart)
        );
        if (rc?.enabled && realReview && !alreadyHas) {
          const custom = rc.description?.trim();
          await issueCoupon(
            currentUser.id, storeId, "review",
            custom || t("review.rewardDefault", "ko"),
            Math.max(0, Number(rc.amount) || 0),
            // silent: 발급 토스트 억제(도착 알림으로 일원화). custom 없으면 descKey 저장 → 손님 언어로 번역 표시(#20)
            { silent: true, ...(custom ? {} : { descKey: "review.rewardDefault" }) }
          );
        }
      }
      await payTableSession(currentUser.id, storeId, myTable.number);
    } catch {
      // store 에서 토스트 처리됨
    }
  };

  const override = tierOverrides.find(
    (o) => o.customerId === currentUser?.id && o.storeId === storeId
  )?.tier;
  const uniqueDays = new Set(myVisits.map((v) => new Date(v.date).toDateString())).size;
  const tier = getEffectiveTier(uniqueDays, override);
  const tierName = owner?.tierNames?.[tier] ?? tier;
  const next = getNextTier(tier);
  const progress = next ? Math.min(uniqueDays / next.min, 1) : 1;

  // 로그인 상태 로딩 중 — 흰 화면 깜빡임 대신 안내 화면
  if (!currentUser) {
    return (
      <MobileShell>
        <div className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-[var(--color-navy-50)] inline-flex items-center justify-center mb-3">
            <UserIcon className="w-6 h-6 text-[var(--color-navy-700)]" />
          </div>
          <p className="text-[14px] font-bold text-[var(--color-navy-900)]">{t("home.loginLoading", lang)}</p>
          <p className="text-[12px] text-[var(--color-ink-500)] mt-1.5 font-medium">
            {t("home.loginLoadingDesc", lang)}
          </p>
        </div>
      </MobileShell>
    );
  }

  return (
    <MobileShell
      bottomNav={<BottomNav tab={tab} setTab={setTab} couponBadge={unseenCoupons} />}
    >
      <TopBar
        title={owner?.restaurantName ?? t("common.store", lang)}
        back={() => nav("/customer")}
        right={
          <Link
            to="/customer"
            className="w-11 h-11 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center justify-center"
            aria-label="내 결"
          >
            <UserIcon className="w-5 h-5 text-[var(--color-navy-800)]" />
          </Link>
        }
      />

      {tab === "home" && (
        <div className="px-5 pt-3 space-y-4">
          {/* 영업 외 시간 안내 배너 — 영업 중이 아니면 상단에 빨간 카드 */}
          <StoreStatusBanner owner={owner} />

          {/* Tier card */}
          <Card className="bg-[var(--color-navy-700)] text-white border-transparent shadow-[var(--shadow-navy)] p-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[13px] font-semibold opacity-90">{t("home.greeting", lang, { name: currentUser.name })}</p>
                <p className="text-[24px] font-extrabold tracking-tight mt-0.5">{tierName}</p>
              </div>
              <Sparkles className="w-6 h-6 opacity-80" />
            </div>
            {next ? (
              <>
                <div className="h-2 rounded-full bg-white/15 overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-mint-400)] rounded-full transition-[width]"
                    style={{ width: `${progress * 100}%` }}
                  />
                </div>
                <p className="text-[13px] font-semibold opacity-90 mt-3">
                  {t("home.nextTier", lang, { tier: next.tier, n: Math.max(next.min - uniqueDays, 0) })}
                </p>
              </>
            ) : (
              <p className="text-[13px] font-semibold opacity-90">{t("home.topTier", lang)}</p>
            )}
          </Card>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-2">
            <SmallStat label={t("home.stat.visits", lang)} value={`${myVisits.length}${t("home.unit.visit", lang)}`} />
            <SmallStat label={t("home.stat.coupons", lang)} value={`${myCoupons.filter((c) => c.status !== "used").length}${t("home.unit.coupon", lang)}`} />
            <SmallStat label={t("home.stat.points", lang)} value={`${(currentUser.rewardBalance ?? 0).toLocaleString()}`} />
          </div>

          {/* 8-2: 가게 브랜드 사이트 — 메뉴·리뷰·소개를 예쁜 페이지로 (주문 후 자연히 노출) */}
          <Link
            to={`/site/${storeId}`}
            className="flex items-center justify-between gap-3 rounded-2xl bg-white border border-[var(--color-line)] p-4 active:scale-[0.99] transition-transform"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-[var(--color-mint-100)] text-[var(--color-mint-700)] inline-flex items-center justify-center shrink-0">
                <Store className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-extrabold text-[var(--color-navy-900)] truncate">{t("home.storeSite", lang)}</p>
                <p className="text-[12px] text-[var(--color-ink-500)] truncate">{t("home.storeSiteDesc", lang)}</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-[var(--color-ink-300)] shrink-0" />
          </Link>

          {/* Active table HUD */}
          {myTable && (
            <>
              <Card padding="md" className="flex items-center gap-3 border-[var(--color-mint-300)]">
                <div className="w-12 h-12 rounded-xl bg-[var(--color-mint-100)] text-[var(--color-mint-700)] inline-flex items-center justify-center font-extrabold">
                  {myTable.number}
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-bold text-[var(--color-navy-900)]">{t("home.tableInUse", lang, { n: myTable.number })}</p>
                  <SessionTimer start={myTable.sessionStartTime ?? null} />
                </div>
              </Card>
              {/* 계산서 · 가게 퇴장 — 손님이 직접 컨트롤 */}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  block
                  onClick={() => setBillOpen(true)}
                  leftIcon={<ReceiptIcon className="w-4 h-4" />}
                  disabled={mySessionOrders.length === 0}
                >
                  {t("home.viewBill", lang)}
                </Button>
                <Button
                  variant="ghost"
                  block
                  onClick={handleExitStore}
                  leftIcon={<DoorOpen className="w-4 h-4" />}
                >
                  {t("home.leaveStore", lang)}
                </Button>
              </div>
            </>
          )}

          {/* Session orders & 결제 */}
          {mySessionOrders.length > 0 && (
            <Card padding="md">
              <div className="flex items-center gap-2 mb-3">
                <ReceiptIcon className="w-4 h-4 text-[var(--color-navy-700)]" />
                <p className="text-[13px] font-bold text-[var(--color-navy-900)]">
                  {t("home.currentOrders", lang, { n: mySessionOrders.length })}
                </p>
              </div>

              {myActiveOrder && myActiveOrder.status !== "cancelled" && (
                <OrderProgress status={myActiveOrder.status} industry={owner?.storeConfig?.industry} />
              )}
              {myActiveOrder && myActiveOrder.status === "cancelled" && (
                <div className="mb-3 px-3 py-2 rounded-xl bg-[#fef2f2] text-[var(--color-danger)] text-[13px] font-bold text-center">
                  {t("home.orderCancelled", lang)}
                </div>
              )}

              <ul className="divide-y divide-[var(--color-line-soft)] -mx-1">
                {mySessionOrders.map((o) => (
                  <li key={o.id} className="py-2 px-1 flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[12px] text-[var(--color-ink-600)] font-semibold tabular-nums">
                          {new Date(o.createdAt).toLocaleTimeString(lang === "ko" ? "ko-KR" : lang === "zh" ? "zh-CN" : lang === "vi" ? "vi-VN" : "en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {o.paymentStatus === "paid" ? (
                          <span className="text-[11px] font-bold text-[var(--color-mint-700)] bg-[var(--color-mint-100)] px-1.5 py-0.5 rounded">
                            {t("pay.paid", lang)}
                          </span>
                        ) : (
                          <span className="text-[11px] font-bold text-[var(--color-warn)] bg-[#fff1e0] px-1.5 py-0.5 rounded">
                            {t("pay.unpaid", lang)}
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] text-[var(--color-ink-700)] break-keep line-clamp-2">
                        {o.items.map((it) => `${it.name}${it.selectedOptions?.length ? `(${it.selectedOptions.map((op) => op.optionName).join("·")})` : ""}×${it.quantity}`).join(", ")}
                      </p>
                    </div>
                    <span className="text-[13px] font-bold text-[var(--color-navy-900)] tabular-nums shrink-0">
                      {fmtKRW(o.totalAmount, lang)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 pt-3 border-t border-[var(--color-line)] flex items-center justify-between">
                <span className="text-[13px] font-bold text-[var(--color-ink-600)]">{t("home.unpaidSum", lang)}</span>
                <span className="text-[18px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                  {fmtKRW(unpaidTotal, lang)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-3">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setBillOpen(true)}
                  leftIcon={<ReceiptIcon className="w-4 h-4" />}
                >
                  {t("home.viewBill", lang)}
                </Button>
                {(() => {
                  const hasRequested = mySessionOrders.some((o) => o.paymentStatus === "requested");
                  if (hasRequested) {
                    return (
                      <Button size="md" disabled leftIcon={<CreditCard className="w-4 h-4" />}>
                        {t("home.paying", lang)}
                      </Button>
                    );
                  }
                  if (unpaidTotal > 0 && myTable) {
                    return (
                      <Button
                        size="md"
                        onClick={handlePay}
                        leftIcon={<CreditCard className="w-4 h-4" />}
                      >
                        {t("home.payButton", lang)}
                      </Button>
                    );
                  }
                  return (
                    <Button size="md" disabled leftIcon={<CreditCard className="w-4 h-4" />}>
                      {t("home.payDone", lang)}
                    </Button>
                  );
                })()}
              </div>
              {mySessionOrders.some((o) => o.paymentStatus === "requested") && (
                <div className="mt-3 py-2.5 px-3 rounded-xl bg-[#fff8e6] text-[var(--color-warn)] text-[12.5px] font-bold text-center border border-[var(--color-warn)]/30">
                  {t("home.payRequestedNote", lang)}
                </div>
              )}
              {unpaidTotal === 0 && mySessionOrders.length > 0 && (
                <div className="mt-3 py-2.5 px-3 rounded-xl bg-[var(--color-mint-100)] text-[var(--color-mint-700)] text-[13px] font-bold text-center">
                  {t("home.allPaid", lang)}
                </div>
              )}
            </Card>
          )}

          {/* 지난 방문 영수증 — 같은 매장 재방문 시 명확히 분리 */}
          {pastVisits.length > 0 && <PastVisitsCard visits={pastVisits} storeName={owner?.restaurantName ?? t("common.store", lang)} />}

          {/* Recent visits */}
          <div>
            <h2 className="text-[14px] font-bold text-[var(--color-navy-900)] mb-2 px-1">{t("home.recentVisits", lang)}</h2>
            {myVisits.length === 0 ? (
              <Card padding="lg" className="text-center">
                <Sparkles className="w-7 h-7 text-[var(--color-ink-300)] mx-auto mb-2" />
                <p className="text-[14px] text-[var(--color-ink-600)] font-medium">
                  {t("home.firstVisit", lang)}
                </p>
                <p className="text-[12px] text-[var(--color-ink-500)] mt-1">
                  {t("home.firstVisitDesc", lang)}
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {myVisits.slice(0, 5).map((v) => {
                  const locale = getLocale(lang);
                  return (
                    <Card key={v.id} padding="md" className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--color-navy-50)] text-[var(--color-navy-700)] inline-flex items-center justify-center font-bold text-[12px]">
                        {v.tableNumber}
                      </div>
                      <div className="flex-1">
                        <p className="text-[13px] font-semibold text-[var(--color-navy-900)]">
                          {new Date(v.date).toLocaleDateString(locale, { month: "long", day: "numeric" })}
                        </p>
                        <p className="text-[12px] text-[var(--color-ink-600)]">
                          {new Date(v.date).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                      {v.totalAmount && (
                        <p className="text-[13px] font-bold text-[var(--color-navy-800)]">
                          {fmtKRW(v.totalAmount, lang)}
                        </p>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "menu" && (
        <div className="px-5 pt-3" style={{ paddingBottom: "calc(64px + env(safe-area-inset-bottom) + 88px)" }}>
          {/* #19: 사이트/홈에서 들어와 테이블이 없으면 주문 버튼이 막히므로, 어떻게 자리를 잡는지 안내 */}
          {!myTable && (
            <Card padding="md" className="mt-2 mb-3 border-[1.5px] border-[var(--color-mint-300)] bg-[var(--color-mint-50)]">
              <p className="text-[13.5px] font-extrabold text-[var(--color-navy-900)]">{t("menu.needTableTitle", lang)}</p>
              <p className="text-[12px] text-[var(--color-ink-600)] mt-0.5 leading-relaxed">{t("menu.needTableHint", lang)}</p>
              <Link to="/scan" className="inline-flex items-center justify-center gap-1 mt-2.5 h-10 px-5 rounded-full bg-[var(--color-navy-700)] text-white text-[12.5px] font-bold">{t("menu.needTableCta", lang)}</Link>
            </Card>
          )}
          {storeMenus.length === 0 ? (
            <Card padding="lg" className="text-center mt-2">
              <UtensilsCrossed className="w-8 h-8 text-[var(--color-ink-300)] mx-auto mb-2" />
              <p className="text-[14px] text-[var(--color-ink-500)] font-medium">
                {t("menu.empty", lang)}
              </p>
            </Card>
          ) : (
            Object.entries(menuByCat).map(([cat, items]) => (
              <div key={cat} className="mt-2">
                <h3 className="text-[13px] font-bold text-[var(--color-ink-600)] uppercase tracking-wide px-1 mb-2 mt-3">
                  {cat}
                </h3>
                <div className="space-y-2">
                  {items.map((m) => (
                    <Card key={m.id} padding="md" className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-bold text-[var(--color-navy-900)]">{m.name}</p>
                        {m.description && (
                          <p className="text-[13px] text-[var(--color-ink-600)] line-clamp-2 break-keep">{m.description}</p>
                        )}
                        <p className="text-[13px] font-bold text-[var(--color-navy-700)] mt-1">
                          {fmtKRW(m.price, lang)}
                        </p>
                      </div>
                      {m.optionGroups?.length ? (
                        <button
                          type="button"
                          onClick={() => setPicker(m)}
                          className="h-9 px-3.5 rounded-full bg-[var(--color-navy-700)] text-white text-[13px] font-bold inline-flex items-center gap-1 flex-shrink-0"
                        >
                          <Plus className="w-4 h-4" />
                          {t("opt.pick", lang)}
                          {menuInCart(m.id) > 0 && (
                            <span className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-white/25 text-[11px] inline-flex items-center justify-center">
                              {menuInCart(m.id)}
                            </span>
                          )}
                        </button>
                      ) : (
                        <QtyStepper
                          value={cart[m.id]?.qty ?? 0}
                          onChange={(v) =>
                            setCart((c) => {
                              const next = { ...c };
                              if (v <= 0) delete next[m.id];
                              else next[m.id] = { menuId: m.id, qty: v, selectedOptions: [], unitPrice: m.price };
                              return next;
                            })
                          }
                        />
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            ))
          )}

          {cartItems.length > 0 && (
            <div
              className="fixed lg:absolute left-1/2 -translate-x-1/2 w-full max-w-[480px] px-5 z-30"
              style={{ bottom: "calc(64px + env(safe-area-inset-bottom) + 8px)" }}
            >
              <button
                onClick={() => setCartOpen(true)}
                className="w-full h-14 rounded-[18px] bg-[var(--color-navy-700)] text-white font-bold shadow-[var(--shadow-navy)] flex items-center justify-between px-5 active:scale-[0.98] transition-transform"
              >
                <span className="inline-flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4" />
                  {t("cart.view", lang, { n: cartCount })}
                </span>
                <span>{fmtKRW(cartTotal, lang)}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* 장바구니 시트 — 옵션 라인 확인·수량·삭제 후 주문 */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => setCartOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-5 sm:p-6 pb-[max(env(safe-area-inset-bottom),20px)] sm:pb-6 max-h-[88vh] flex flex-col"
          >
            <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-4 sm:hidden" />
            <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)] mb-3">{t("cart.title", lang)}</h2>
            {cartItems.length === 0 ? (
              <p className="text-[14px] text-[var(--color-ink-500)] py-10 text-center">{t("cart.empty", lang)}</p>
            ) : (
              <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2.5">
                {cartItems.map((c) => (
                  <div key={c.key} className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-[14px] font-bold text-[var(--color-navy-900)] break-keep">{c.menu.name}</p>
                      {c.selectedOptions.length > 0 && (
                        <p className="text-[12px] text-[var(--color-ink-500)] break-keep">{optSummary(c.selectedOptions)}</p>
                      )}
                      <p className="text-[12.5px] font-semibold text-[var(--color-navy-700)] mt-0.5">{fmtKRW(c.unitPrice * c.qty, lang)}</p>
                    </div>
                    <QtyStepper value={c.qty} onChange={(v) => setLineQty(c.key, v)} />
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between mt-4 mb-3">
              <span className="text-[14px] font-bold text-[var(--color-ink-600)]">{t("cart.total", lang)}</span>
              <span className="text-[17px] font-extrabold text-[var(--color-navy-900)]">{fmtKRW(cartTotal, lang)}</span>
            </div>
            <button
              onClick={submitOrder}
              disabled={!myTable || cartItems.length === 0}
              className="h-[52px] rounded-[18px] bg-[var(--color-navy-700)] text-white font-bold text-[15px] inline-flex items-center justify-center shadow-[var(--shadow-navy)] disabled:opacity-50"
            >
              {myTable ? t("cart.submit", lang) : t("menu.needTable", lang)}
            </button>
          </div>
        </div>
      )}
      {picker && <OptionPickerModal menu={picker} onConfirm={onPickerConfirm} onClose={() => setPicker(null)} />}

      {tab === "coupons" && (
        <div className="px-5 pt-3 space-y-3">
          <h2 className="text-[15px] font-bold text-[var(--color-navy-900)] px-1">{t("coupons.title", lang)}</h2>
          {myCoupons.length === 0 ? (
            <Card padding="lg" className="text-center">
              <Ticket className="w-8 h-8 text-[var(--color-ink-300)] mx-auto mb-2" />
              <p className="text-[14px] text-[var(--color-ink-500)] font-medium">
                {t("coupons.empty", lang)}
              </p>
            </Card>
          ) : (
            myCoupons.map((c) => (
              <CouponRow
                key={c.id}
                coupon={c}
                tableNumber={myTable?.number}
                onUse={() => requestCouponUse(c.id, myTable?.number)}
                onCancel={() => cancelCouponRequest(c.id)}
              />
            ))
          )}
        </div>
      )}

      {tab === "profile" && (
        <div className="px-5 pt-3 space-y-3">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-4">
              {currentUser.avatarUrl ? (
                <img src={currentUser.avatarUrl} className="w-14 h-14 rounded-full" alt="" />
              ) : (
                <div className="w-14 h-14 rounded-full bg-[var(--color-navy-100)] text-[var(--color-navy-700)] inline-flex items-center justify-center font-extrabold text-lg">
                  {currentUser.name?.[0] ?? "결"}
                </div>
              )}
              <div>
                <p className="text-[17px] font-extrabold text-[var(--color-navy-900)]">{currentUser.name}</p>
                <p className="text-[12px] text-[var(--color-ink-500)]">{currentUser.phone || "—"}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[12px] text-[var(--color-ink-700)]">
              <Info label={t("profile.joinType", lang)} value={currentUser.authType ?? "phone"} />
              <Info label={t("profile.ageGroup", lang)} value={currentUser.ageGroup ?? "—"} />
            </div>
          </Card>

          {/* 언어 선택 — 설정의 언어 탭 (손님 측 진입 위치) */}
          <Card padding="md">
            <p className="text-[13px] font-bold text-[var(--color-navy-900)] mb-1">{t("profile.languageTitle", lang)}</p>
            <p className="text-[11.5px] text-[var(--color-ink-500)] font-medium mb-2.5">
              {t("profile.languageDesc", lang)}
            </p>
            <div className="flex gap-2 flex-wrap">
              {LANGS.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => setLanguage(l.code)}
                  className={cn(
                    "h-9 px-3.5 rounded-full border text-[12.5px] font-bold",
                    lang === l.code
                      ? "bg-[var(--color-navy-700)] text-white border-transparent"
                      : "bg-white text-[var(--color-ink-700)] border-[var(--color-line)]"
                  )}
                >
                  {l.native}
                </button>
              ))}
            </div>
          </Card>

          <Button block variant="ghost" onClick={() => { logout(); nav("/", { replace: true }); }} leftIcon={<LogOut className="w-4 h-4" />}>
            {t("profile.logout", lang)}
          </Button>
          <Button
            block
            variant="outline"
            onClick={async () => {
              if (confirm(t("profile.deleteConfirm", lang))) {
                await deleteAccount();
                nav("/", { replace: true });
              }
            }}
            leftIcon={<Trash2 className="w-4 h-4" />}
            className="text-[var(--color-danger)] border-[var(--color-danger)]/30 hover:border-[var(--color-danger)]"
          >
            {t("profile.deleteAccount", lang)}
          </Button>
        </div>
      )}

      {/* 계산서 모달 */}
      {billOpen && currentUser && (
        <BillModal
          storeName={owner?.restaurantName ?? t("common.store", lang)}
          tableNumber={myTable?.number}
          customerName={currentUser.name}
          orders={mySessionOrders}
          unpaidTotal={unpaidTotal}
          paidTotal={mySessionOrders.filter((o) => o.paymentStatus === "paid").reduce((s, o) => s + o.totalAmount, 0)}
          canPay={!!myTable}
          onClose={() => setBillOpen(false)}
          onPay={() => {
            setBillOpen(false);
            handlePay();
          }}
          onPayCard={() => {
            if (!myTable || unpaidTotal <= 0) return;
            setBillOpen(false);
            const orderIds = mySessionOrders
              .filter((o) => o.paymentStatus !== "paid" && o.status !== "cancelled")
              .map((o) => o.id);
            startCardPayment({
              clientKey: owner?.storeConfig?.tossClientKey,
              storeId,
              tableNumber: myTable.number,
              customerId: currentUser.id,
              amount: unpaidTotal,
              orderName: owner?.restaurantName ?? t("common.store", lang),
              orderIds,
            }).catch(() => showToast(t("pay.failDesc", lang), "error"));
          }}
        />
      )}

      {/* 리뷰 입력 모달 — 결제 요청 전에 사진+별점+글 받기 (선택). 건너뛰기 가능. */}
      {reviewOpen && (
        <ReviewModal
          unpaidTotal={unpaidTotal}
          onCancel={() => setReviewOpen(false)}
          onSubmit={(review) => {
            submitPaymentWithReview(review);
          }}
        />
      )}
    </MobileShell>
  );
}

// ============================================================
// 매장 영업 상태 배너 — 영업 외 시간이면 빨간 카드, 영업 중이면 작은 칩

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "../lib/i18n";
import { LS_USER } from "./constants";
import type { DbStatus } from "./types";
import type { User, Visit, Coupon, TableDoc, Communication, Section, TierOverride, Menu, Order, Reservation, Photo, Shift, Ingredient, Expense, MarketingDraft } from "../lib/types";

/**
 * Provider 가 소유하는 모든 상태·setter·ref 를 한 덩어리로 만든다.
 *
 * 도메인 액션 훅(actions/*.ts)은 이 객체 하나만 받는다. 훅마다 setter 를 20개씩
 * 인자로 나열하는 대신 여기서 한 번만 정의하고, 각 훅은 필요한 것만 구조분해한다.
 */
export function useStoreCore() {
  const [isReady, setReady] = useState(false);
  const [dbStatus, setDbStatus] = useState<DbStatus>("connecting");
  const [dbError, setDbError] = useState<string | null>(null);
  const [currentUser, setCurrentUserState] = useState<User | null>(null);
  const [masterPassword, setMasterPasswordState] = useState("IMC");
  const [isMaster, setIsMaster] = useState(false);

  const [users, setUsers] = useState<User[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [tables, setTables] = useState<TableDoc[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [tierOverrides, setTierOverrides] = useState<TierOverride[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const ingredientsRef = useRef<Ingredient[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [marketingDrafts, setMarketingDrafts] = useState<MarketingDraft[]>([]);
  useEffect(() => { ingredientsRef.current = ingredients; }, [ingredients]);

  const scopedUnsubsRef = useRef<Array<() => void>>([]);
  const storeContextUnsubsRef = useRef<Array<() => void>>([]);
  const [activeStoreId, setActiveStoreId] = useState<string | null>(null);

  // 최신 상태를 캡처하기 위한 ref (useCallback identity 안정화)
  const usersRef = useRef<User[]>(users);
  const visitsRef = useRef<Visit[]>(visits);
  const couponsRef = useRef<Coupon[]>(coupons);
  const tablesRef = useRef<TableDoc[]>(tables);
  const menusRef = useRef<Menu[]>(menus);
  const sectionsRef = useRef<Section[]>(sections);
  const ordersRef = useRef<Order[]>(orders);
  const reservationsRef = useRef<Reservation[]>(reservations);
  const marketingDraftsRef = useRef<MarketingDraft[]>(marketingDrafts);
  const currentUserRef = useRef<User | null>(currentUser);
  // 결제 승인 중복 실행 방지 (테이블별 in-flight set, 멱등성 보장)
  const approvingPaymentRef = useRef<Set<string>>(new Set());
  // 출퇴근 중복 실행 방지 — 버튼 연타 시 shifts(onSnapshot 왕복 후 갱신) 기반 가드만으로는
  // 두 호출이 모두 open===undefined 를 보고 각각 새 shift 를 만들 수 있어 동기 ref 로 막는다.
  const clockingRef = useRef(false);
  useEffect(() => { usersRef.current = users; }, [users]);
  useEffect(() => { visitsRef.current = visits; }, [visits]);
  useEffect(() => { couponsRef.current = coupons; }, [coupons]);
  useEffect(() => { tablesRef.current = tables; }, [tables]);
  useEffect(() => { menusRef.current = menus; }, [menus]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);
  useEffect(() => { reservationsRef.current = reservations; }, [reservations]);
  useEffect(() => { marketingDraftsRef.current = marketingDrafts; }, [marketingDrafts]);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  // 사장님이 앱 언어를 바꾸면 User.lang 에 저장 — 손님/직원 기기가 주문·결제·쿠폰 푸시를
  // 만들 때 이 값을 읽어 '사장님이 설정한 언어'로 알림을 보냄(수신자 언어 = 사장님 언어).
  const lang = useLanguage();

  const setCurrentUser = useCallback((u: User | null) => {
    setCurrentUserState(u);
    if (u) localStorage.setItem(LS_USER, JSON.stringify(u));
    else localStorage.removeItem(LS_USER);
  }, []);

  // 컨텍스트 매장 id (사장님=본인 id, 직원=employerStoreId, 그 외="")
  const effectiveStoreId = useMemo(() => {
    if (!currentUser) return "";
    if (currentUser.role === "owner") return currentUser.id;
    if (currentUser.role === "staff" && currentUser.employerStatus === "approved")
      return currentUser.employerStoreId ?? "";
    return "";
  }, [currentUser]);

  // silence unused warning

  return {
    isReady,
    setReady,
    dbStatus,
    setDbStatus,
    dbError,
    setDbError,
    currentUser,
    setCurrentUserState,
    masterPassword,
    setMasterPasswordState,
    isMaster,
    setIsMaster,
    users,
    setUsers,
    visits,
    setVisits,
    coupons,
    setCoupons,
    tables,
    setTables,
    sections,
    setSections,
    communications,
    setCommunications,
    tierOverrides,
    setTierOverrides,
    menus,
    setMenus,
    orders,
    setOrders,
    reservations,
    setReservations,
    photos,
    setPhotos,
    shifts,
    setShifts,
    ingredients,
    setIngredients,
    ingredientsRef,
    expenses,
    setExpenses,
    marketingDrafts,
    setMarketingDrafts,
    scopedUnsubsRef,
    storeContextUnsubsRef,
    activeStoreId,
    setActiveStoreId,
    usersRef,
    visitsRef,
    couponsRef,
    tablesRef,
    menusRef,
    sectionsRef,
    ordersRef,
    reservationsRef,
    marketingDraftsRef,
    currentUserRef,
    approvingPaymentRef,
    clockingRef,
    lang,
    setCurrentUser,
    effectiveStoreId,
  };
}

export type StoreCore = ReturnType<typeof useStoreCore>;

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
  writeBatch,
  increment,
  arrayUnion,
} from "firebase/firestore";
import { db, isFirebaseConfigured, ensureAnonymousAuth } from "../lib/firebase";
import { updateFirestoreDoc, flushOfflineQueue } from "../lib/firestore";
import { calculateAgeGroup } from "../lib/auth";
import { generateId, digitsOnly } from "../lib/ids";
import { showToast } from "../lib/toast";
import { t, useLanguage, fmtKRW, getLanguage } from "../lib/i18n";
import { getCustomerTier } from "../lib/tier";
import { relayOrderToPos } from "../lib/pos";
import { printReceipt } from "../lib/receipt";
import { printReceiptViaUsb, getAuthorizedPrinters } from "../lib/thermalPrinter";
import { enqueuePrintJob } from "../lib/printBridge";
import { sendOwnerPush } from "../lib/pushTriggers";
import { api } from "../lib/api";
import { getStoreOpenStatus } from "../lib/businessHours";
import type {
  User,
  StaffLevel,
  Visit,
  Coupon,
  TableDoc,
  Communication,
  Section,
  TierOverride,
  Menu,
  Order,
  OrderItem,
  OrderStatus,
  Reservation,
  Photo,
  Role,
  AuthType,
  Tier,
  TableStatus,
  Shift,
  Ingredient,
  Expense,
  MarketingDraft,
} from "../lib/types";

type FirebaseStatus = "connecting" | "ok" | "error" | "offline";

interface StoreState {
  isReady: boolean;
  firebaseStatus: FirebaseStatus;
  firebaseError: string | null;
  currentUser: User | null;
  masterPassword: string;
  isMaster: boolean;

  users: User[];
  visits: Visit[];
  coupons: Coupon[];
  tables: TableDoc[];
  sections: Section[];
  communications: Communication[];
  tierOverrides: TierOverride[];
  menus: Menu[];
  orders: Order[];
  reservations: Reservation[];
  photos: Photo[];
  shifts: Shift[];
  ingredients: Ingredient[];
  expenses: Expense[];
  marketingDrafts: MarketingDraft[];

  /** 현재 컨텍스트의 매장 id (사장님=자기 id, 직원=employerStoreId) */
  effectiveStoreId: string;
  /** 현재 사용자의 진행 중인 근무 (clockOutAt이 없는 것). 직원만 의미 있음. */
  activeShift: Shift | null;

  /** 고객이 현재 보고 있는 매장 (이 ID가 설정된 동안 tables/menus/orders를 해당 매장으로 구독) */
  activeStoreId: string | null;
  setActiveStoreId: (id: string | null) => void;

  // auth
  login: (input: LoginInput) => Promise<User>;
  logout: () => void;
  deleteAccount: () => Promise<void>;
  setMasterPassword: (pw: string) => Promise<void>;
  /** 전화번호 SMS 인증 완료 마킹 — Firebase Auth 검증 후 호출. */
  markPhoneVerified: (userId: string, e164Phone?: string) => Promise<void>;
  loginMaster: (pw: string) => boolean;
  logoutMaster: () => void;
  deleteUser: (userId: string, role: Role) => Promise<void>;

  // visits & coupons
  recordVisit: (customerId: string, tableNumber: number, storeId: string, amount?: number) => Promise<void>;
  leaveTable: (tableNumber: number, storeId: string) => Promise<void>;
  /** 손님 측 — QR 진입 시 테이블 점유 시작 (합석 시 occupantIds 추가) */
  enterTable: (input: {
    tableNumber: number;
    storeId: string;
    customerId: string;
    customerName?: string;
    partySize?: number;
  }) => Promise<void>;
  /** 사장님 측 — 손님 강제 퇴장 (미결제 주문은 cancelled 로) */
  evictTable: (tableNumber: number, storeId: string) => Promise<void>;
  issueCoupon: (customerId: string, storeId: string, type: string, description: string, amount?: number, opts?: { silent?: boolean; descKey?: string }) => Promise<void>;
  requestCouponUse: (couponId: string, tableNumber?: number) => Promise<void>;
  cancelCouponRequest: (couponId: string) => Promise<void>;
  approveCouponUse: (couponId: string) => Promise<void>;
  rejectCouponUse: (couponId: string) => Promise<void>;

  // tables & sections
  addTable: (storeId: string, type?: TableDoc["type"], sectionId?: string) => Promise<void>;
  updateTableLayout: (storeId: string, number: number, data: Partial<TableDoc>) => Promise<void>;
  deleteTable: (storeId: string, number: number) => Promise<void>;
  updateTableStatus: (storeId: string, number: number, status: TableStatus) => Promise<void>;
  initTables: (storeId: string) => Promise<void>;
  addSection: (storeId: string, name: string) => Promise<void>;
  updateSection: (id: string, data: Partial<Section>) => Promise<void>;
  deleteSection: (id: string) => Promise<void>;

  // menus
  addMenuItem: (storeId: string, data: Omit<Menu, "id" | "storeId">, silent?: boolean) => Promise<void>;
  updateMenuItem: (id: string, data: Partial<Menu>) => Promise<void>;
  deleteMenuItem: (id: string) => Promise<void>;
  addIngredient: (storeId: string, data: Omit<Ingredient, "id" | "storeId" | "updatedAt">) => Promise<void>;
  updateIngredient: (id: string, data: Partial<Ingredient>) => Promise<void>;
  deleteIngredient: (id: string) => Promise<void>;
  addExpense: (storeId: string, data: Omit<Expense, "id" | "storeId" | "createdAt">) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;

  // 마케팅 에이전트 초안 — 모두 '초안'으로 생성되어 사장 승인 후 발행. 전 상태전이 audit 로깅(TODO 7-3).
  addMarketingDraft: (
    storeId: string,
    data: Pick<MarketingDraft, "channel" | "kind" | "content"> & {
      title?: string;
      source?: MarketingDraft["source"];
      targetId?: string;
      targetSummary?: string;
    }
  ) => Promise<void>;
  /** 초안 검토 — approve/reject/publish. audit 에 행위·시각·사유 기록. */
  reviewMarketingDraft: (id: string, action: "approve" | "reject" | "publish", note?: string) => Promise<void>;
  /** 초안 본문 수정 — audit 에 edited 기록. */
  updateMarketingDraftContent: (id: string, content: string, title?: string) => Promise<void>;
  deleteMarketingDraft: (id: string) => Promise<void>;

  // orders
  placeOrder: (input: {
    storeId: string;
    tableNumber: number;
    customerId: string;
    items: OrderItem[];
    /** 사장/직원이 카운터(빠른 주문)에서 직접 입력하는 주문 — 영업시간·임시마감 검증을 건너뜀 */
    manual?: boolean;
  }) => Promise<Order>;
  updateOrderStatus: (id: string, status: OrderStatus) => Promise<void>;
  /** 손님 측 — 결제 요청만 보냄(paymentStatus: requested). 실제 결제는 사장님 승인. */
  payTableSession: (
    customerId: string,
    storeId: string,
    tableNumber: number
  ) => Promise<number>;
  /** 사장님 측 — 결제 승인. paid 처리 + 총 영수증 인쇄. table.status: paid */
  approvePayment: (storeId: string, tableNumber: number) => Promise<number>;
  moveOrdersTable: (storeId: string, fromTable: number, toTable: number) => Promise<void>;
  /** 손님/사장님 카드결제 성공(토스 successUrl) → 서버 confirm + 해당 손님 미결제 주문 paid. */
  confirmTossPayment: (params: {
    storeId: string;
    customerId: string;
    tableNumber: number;
    paymentKey: string;
    orderId: string;
    amount: number;
    orderIds: string[];
  }) => Promise<void>;
  /** 사장님 측 — 계산 완료. 테이블 정리 (status: available + occupant null) */
  completeTable: (storeId: string, tableNumber: number) => Promise<void>;
  /** 사장님 또는 손님 측 — 중간 계산서 즉시 출력 (정식 영수증 아님 표시) */
  printInterimReceipt: (storeId: string, tableNumber: number) => Promise<void>;

  // CRM
  recordCommunication: (
    customerId: string,
    storeId: string,
    type: "coupon" | "message",
    content: string,
    senderRole?: "owner" | "customer"
  ) => Promise<void>;
  updateUserMemo: (userId: string, memo: string) => Promise<void>;
  setStaffWage: (userId: string, hourlyWage: number) => Promise<void>;
  /** 직원 권한 등급(1~4) 지정 — 사장님 직원관리. */
  setStaffLevel: (userId: string, level: StaffLevel) => Promise<void>;
  /** 직원 개별 추가 권한(extraPerms 경로 목록) 지정 — 등급 기본을 넘어 개방. */
  setStaffPerms: (userId: string, perms: string[]) => Promise<void>;
  setCustomerTier: (customerId: string, storeId: string, tier: Tier | "auto") => Promise<void>;
  bulkIssueCoupon: (customerIds: string[], storeId: string, type: string, description: string, amount?: number, descKey?: string) => Promise<void>;
  updateBrandSettings: (storeId: string, data: Partial<User>) => Promise<void>;
  updateStoreConfig: (storeId: string, partial: Partial<NonNullable<User["storeConfig"]>>) => Promise<void>;
  updateStoreLocation: (storeId: string, lat: number, lng: number) => Promise<void>;

  // reservations
  addReservation: (input: Omit<Reservation, "id" | "createdAt" | "status"> & { status?: Reservation["status"] }) => Promise<void>;
  updateReservation: (id: string, data: Partial<Reservation>) => Promise<void>;
  deleteReservation: (id: string) => Promise<void>;

  // photos
  addPhoto: (input: Omit<Photo, "id" | "createdAt">) => Promise<Photo>;
  updatePhoto: (id: string, data: Partial<Photo>) => Promise<void>;
  deletePhoto: (id: string) => Promise<void>;

  // staff membership & shifts
  requestJoinStore: (storeId: string, position?: string) => Promise<void>;
  cancelJoinRequest: () => Promise<void>;
  approveStaff: (staffId: string) => Promise<void>;
  rejectStaff: (staffId: string) => Promise<void>;
  removeStaffMembership: (staffId: string) => Promise<void>;
  clockIn: () => Promise<void>;
  clockOut: () => Promise<void>;
}

interface LoginInput {
  phone: string;
  name: string;
  role: Role;
  restaurantName?: string;
  storeId?: string;
  socialId?: string;
  socialProvider?: "google" | "kakao";
  authType?: AuthType;
  avatarUrl?: string;
  gender?: "male" | "female";
  birthYear?: number;
  birthday?: string;
  isPohangResident?: boolean;
  privacyAgreedAt?: string;
  posVendor?: string;
  posApiKey?: string;
  /** true면 기존 계정만 로그인 허용, 매칭 실패 시 throw (자동 가입 방지) */
  signInOnly?: boolean;
  /** SMS 전번 인증 통과 시각 — 가입 흐름에서 PhoneVerifyModal 인증 직후 동봉. */
  phoneVerifiedAt?: string;
}

const StoreCtx = createContext<StoreState | null>(null);

const LS_USER = "gyeol:currentUser";
const LS_MASTER = "gyeol:isMaster";
const LS_OFFLINE_STATE = "gyeol:offline_state";

// Default 15 tables for new owner
function makeDefaultTables(storeId: string): TableDoc[] {
  return Array.from({ length: 15 }, (_, i) => {
    const n = i + 1;
    const col = (n - 1) % 5;
    const row = Math.floor((n - 1) / 5);
    return {
      id: `${storeId}_${n}`,
      number: n,
      storeId,
      x: col * 120 + 40,
      y: row * 120 + 40,
      width: 90,
      height: 90,
      seats: 4,
      type: "table",
      shape: "square",
      status: "available",
      currentCustomerId: null,
      sessionStartTime: null,
    };
  });
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [isReady, setReady] = useState(false);
  const [firebaseStatus, setFirebaseStatus] = useState<FirebaseStatus>("connecting");
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
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
  useEffect(() => {
    const cu = currentUserRef.current;
    if (cu?.role === "owner" && cu.lang !== lang) {
      updateFirestoreDoc("users", cu.id, { lang }).catch(() => {});
    }
  }, [lang, currentUser]);

  // Persist for offline fallback
  useEffect(() => {
    if (!isReady) return;
    if (firebaseStatus !== "offline") return;
    // 로그아웃/미로그인 상태에서는 캐시를 미러링하지 않는다. logout()이 메모리 상태를 []로 비우는데,
    // 이때 빈 배열로 LS_OFFLINE_STATE 를 덮어쓰면 오프라인 캐시(매장·메뉴·주문)가 영구 소실된다.
    if (!currentUser) return;
    // 디바운스(1s) — 오프라인에서 onSnapshot 이 연달아 오더라도 마지막 1회만 직렬화/저장
    const id = setTimeout(() => {
      localStorage.setItem(
        LS_OFFLINE_STATE,
        JSON.stringify({
          users,
          visits,
          coupons,
          tables,
          sections,
          communications,
          tierOverrides,
          menus,
          orders,
          reservations,
          photos,
          ingredients,
          expenses,
        })
      );
    }, 1000);
    return () => clearTimeout(id);
  }, [
    firebaseStatus,
    isReady,
    currentUser,
    users,
    visits,
    coupons,
    tables,
    sections,
    communications,
    tierOverrides,
    menus,
    orders,
    reservations,
    photos,
    ingredients,
    expenses,
  ]);

  // Boot
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_USER);
      if (raw) setCurrentUserState(JSON.parse(raw));
      if (localStorage.getItem(LS_MASTER) === "1") setIsMaster(true);
    } catch {}

    if (!isFirebaseConfigured || !db) {
      try {
        const raw = localStorage.getItem(LS_OFFLINE_STATE);
        if (raw) {
          const s = JSON.parse(raw);
          setUsers(s.users ?? []);
          setVisits(s.visits ?? []);
          setCoupons(s.coupons ?? []);
          setTables(s.tables ?? []);
          setSections(s.sections ?? []);
          setCommunications(s.communications ?? []);
          setTierOverrides(s.tierOverrides ?? []);
          setMenus(s.menus ?? []);
          setOrders(s.orders ?? []);
          setReservations(s.reservations ?? []);
          setPhotos(s.photos ?? []);
          setIngredients(s.ingredients ?? []);
          setExpenses(s.expenses ?? []);
        }
      } catch {}
      setFirebaseStatus("offline");
      setReady(true);
      return;
    }

    setFirebaseStatus("ok");
    flushOfflineQueue();

    // 익명 로그인 보장 후 listener 등록 — Firestore 보안 규칙의 인증 게이트 통과용.
    // 카카오 사용자는 익명 토큰 위에 자체 매칭, Google 사용자는 익명 → 본 계정 자동 전환.
    let usersUnsub: (() => void) | null = null;
    let cancelled = false;
    ensureAnonymousAuth().then(() => {
      if (cancelled || !db) return;

      // users — 로그인 매칭용 전체 구독
      usersUnsub = onSnapshot(
        collection(db, "users"),
        (snap) => setUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as User))),
        (err) => {
          console.error("[users listener]", err);
          setFirebaseError(err.message);
          setFirebaseStatus("error");
        }
      );

      // Master password — 한 번만 읽기
      getDoc(doc(db, "appState", "settings")).then((s) => {
        if (s.exists()) {
          const data = s.data() as any;
          if (data.masterPassword) setMasterPasswordState(data.masterPassword);
        }
      }).catch((e) => console.warn("[appState/settings]", e?.message));

      setReady(true);
    });

    return () => {
      cancelled = true;
      if (usersUnsub) usersUnsub();
    };
  }, []);

  // Scoped listeners by user role
  useEffect(() => {
    scopedUnsubsRef.current.forEach((u) => u());
    scopedUnsubsRef.current = [];
    if (!db || !currentUser) return;

    const sub = <T,>(
      coll: string,
      setter: (rows: T[]) => void,
      whereField: string,
      value: string
    ) => {
      const q = query(collection(db!, coll), where(whereField, "==", value));
      const un = onSnapshot(
        q,
        (snap) => {
          setter(snap.docs.map((d) => ({ id: d.id, ...d.data() } as T)));
        },
        (err) => {
          // 침묵 실패 방지 — permission-denied 면 보안규칙(firestore.rules) 배포 여부 확인
          console.error(`[onSnapshot ${coll}]`, (err as any)?.code, err?.message);
        }
      );
      scopedUnsubsRef.current.push(un);
    };

    if (currentUser.role === "owner") {
      const sid = currentUser.id;
      sub<Visit>("visits", setVisits, "storeId", sid);
      sub<Coupon>("coupons", setCoupons, "storeId", sid);
      sub<TableDoc>("tables", setTables, "storeId", sid);
      sub<Section>("sections", setSections, "storeId", sid);
      sub<Communication>("Communications", setCommunications, "storeId", sid);
      sub<TierOverride>("tierOverrides", setTierOverrides, "storeId", sid);
      sub<Menu>("menus", setMenus, "storeId", sid);
      sub<Order>("orders", setOrders, "storeId", sid);
      sub<Reservation>("reservations", setReservations, "storeId", sid);
      sub<Photo>("photos", setPhotos, "storeId", sid);
      sub<Shift>("shifts", setShifts, "storeId", sid);
      sub<Ingredient>("ingredients", setIngredients, "storeId", sid);
      sub<Expense>("expenses", setExpenses, "storeId", sid);
      sub<MarketingDraft>("marketingDrafts", setMarketingDrafts, "storeId", sid);
    } else if (currentUser.role === "staff") {
      const sid = currentUser.employerStoreId;
      // 본인 근무 기록은 항상 구독 (승인 전에도 빈 배열)
      sub<Shift>("shifts", setShifts, "staffId", currentUser.id);
      if (sid && currentUser.employerStatus === "approved") {
        sub<TableDoc>("tables", setTables, "storeId", sid);
        sub<Section>("sections", setSections, "storeId", sid);
        sub<Menu>("menus", setMenus, "storeId", sid);
        sub<Order>("orders", setOrders, "storeId", sid);
        sub<Reservation>("reservations", setReservations, "storeId", sid);
        sub<Photo>("photos", setPhotos, "storeId", sid);
        sub<Ingredient>("ingredients", setIngredients, "storeId", sid);
      } else {
        setTables([]);
        setSections([]);
        setMenus([]);
        setOrders([]);
        setReservations([]);
        setPhotos([]);
        setIngredients([]);
      }
    } else {
      // customer: 본인 데이터를 매장 무관하게 구독
      const cid = currentUser.id;
      sub<Visit>("visits", setVisits, "customerId", cid);
      sub<Coupon>("coupons", setCoupons, "customerId", cid);
      sub<Communication>("Communications", setCommunications, "customerId", cid);
      sub<TierOverride>("tierOverrides", setTierOverrides, "customerId", cid);
    }

    return () => {
      scopedUnsubsRef.current.forEach((u) => u());
      scopedUnsubsRef.current = [];
    };
  }, [currentUser?.id, currentUser?.role, currentUser?.employerStoreId, currentUser?.employerStatus]);

  // 고객이 매장에 진입했을 때 그 매장의 tables/menus/orders/photos 구독
  useEffect(() => {
    storeContextUnsubsRef.current.forEach((u) => u());
    storeContextUnsubsRef.current = [];
    if (!db || !currentUser || currentUser.role !== "customer" || !activeStoreId) {
      // 매장 컨텍스트 벗어났을 때 표는 비움 (메모리)
      if (currentUser?.role === "customer") {
        setTables([]);
        setMenus([]);
        setOrders([]);
        setPhotos([]);
      }
      return;
    }

    const sub = <T,>(
      coll: string,
      setter: (rows: T[]) => void,
      field: string = "storeId",
      value: string = activeStoreId!
    ) => {
      const q = query(collection(db!, coll), where(field, "==", value));
      const un = onSnapshot(
        q,
        (snap) => {
          setter(snap.docs.map((d) => ({ id: d.id, ...d.data() } as T)));
        },
        (err) => {
          // 침묵 실패 방지 — permission-denied 면 보안규칙(firestore.rules) 배포 여부 확인
          console.error(`[onSnapshot ${coll}]`, (err as any)?.code, err?.message);
        }
      );
      storeContextUnsubsRef.current.push(un);
    };

    sub<TableDoc>("tables", setTables);
    sub<Menu>("menus", setMenus);
    // 손님은 본인 주문만 필요(Dashboard 가 customerId 로 필터)·매장 전체 주문 구독은
    // 읽기 낭비 + 남의 주문 노출이므로 customerId 로 좁힌다 — 읽기 원가↓ + 프라이버시↑.
    sub<Order>("orders", setOrders, "customerId", currentUser.id);
    sub<Photo>("photos", setPhotos);

    return () => {
      storeContextUnsubsRef.current.forEach((u) => u());
      storeContextUnsubsRef.current = [];
    };
  }, [activeStoreId, currentUser?.id, currentUser?.role]);

  const setCurrentUser = useCallback((u: User | null) => {
    setCurrentUserState(u);
    if (u) localStorage.setItem(LS_USER, JSON.stringify(u));
    else localStorage.removeItem(LS_USER);
  }, []);

  // 사장이 원격으로 바꾸는 직원의 권한 등급·추가권한·승인 상태를, 실행 중인 직원 세션에 실시간 반영.
  // 전역 users 구독은 users 배열만 갱신하고 권한 판정의 원천인 currentUser 는 갱신하지 않아서,
  // 재로그인 전까지 (a) 강등돼도 옛 등급 권한 유지, (b) 승인돼도 Pending 에 묶이고 매장 데이터 구독이
  // 시작되지 않는 문제가 있었다. employerStatus/employerStoreId 가 scoped 구독 effect 의존성(524)이라
  // 이 한 번의 setCurrentUser 로 라우트 가드·NAV·구독 재시작이 모두 정상화된다.
  useEffect(() => {
    if (currentUser?.role !== "staff") return; // 직원 세션만 — 사장/손님 낙관적 패치와 충돌 방지
    const fresh = users.find((u) => u.id === currentUser.id);
    if (!fresh) return;
    const changed =
      fresh.staffLevel !== currentUser.staffLevel ||
      fresh.employerStatus !== currentUser.employerStatus ||
      fresh.employerStoreId !== currentUser.employerStoreId ||
      fresh.position !== currentUser.position ||
      fresh.hourlyWage !== currentUser.hourlyWage ||
      fresh.status !== currentUser.status ||
      JSON.stringify(fresh.extraPerms ?? []) !== JSON.stringify(currentUser.extraPerms ?? []);
    if (!changed) return; // 실제 변경이 있을 때만 set — 무한 루프 방지
    setCurrentUser({
      ...currentUser,
      staffLevel: fresh.staffLevel,
      extraPerms: fresh.extraPerms,
      employerStatus: fresh.employerStatus,
      employerStoreId: fresh.employerStoreId,
      position: fresh.position,
      hourlyWage: fresh.hourlyWage,
      status: fresh.status,
    });
  }, [users, currentUser, setCurrentUser]);

  // ============ LOGIN ============
  const login = useCallback(
    async (input: LoginInput): Promise<User> => {
      // write 전 익명 토큰 보장 — SMS 인증(phoneVerify 보조앱 signOut) 직후 메인 토큰이
      // 미회복 상태면 users 쓰기가 permission-denied 로 막혀, "인증되었어요" 토스트만 뜨고
      // 가입이 그대로 멈춘다. markPhoneVerified 에는 같은 가드가 있었으나 가입 경로엔 없었다.
      await ensureAnonymousAuth();
      const phone = digitsOnly(input.phone);
      const { role, name, restaurantName, storeId, socialId, socialProvider } = input;

      // 1) match by socialId (고객은 전역 계정이므로 storeId 매칭 없이)
      let match: User | undefined;
      if (socialId) {
        match = users.find(
          (u) =>
            u.role === role &&
            (u.socialIds?.includes(socialId) ||
              u.googleId === socialId ||
              u.kakaoId === socialId)
        );
      }
      // 2) match by phone
      if (!match && phone) {
        match = users.find(
          (u) => u.role === role && digitsOnly(u.phone || "") === phone
        );
      }

      if (match) {
        // recover + merge social
        const patch: Partial<User> = {
          status: "active",
          name: match.name || name,
        };
        if (socialId && socialProvider) {
          const socialIds = Array.from(new Set([...(match.socialIds ?? []), socialId]));
          patch.socialIds = socialIds;
          patch.linkedProviders = Array.from(
            new Set([...(match.linkedProviders ?? []), socialProvider])
          );
          if (socialProvider === "google") patch.googleId = socialId;
          if (socialProvider === "kakao") patch.kakaoId = socialId;
          if (input.avatarUrl) patch.avatarUrl = input.avatarUrl;
        }
        if (input.birthYear) {
          patch.birthYear = input.birthYear;
          patch.ageGroup = calculateAgeGroup(input.birthYear);
        }
        if (input.birthday) patch.birthday = input.birthday;
        if (input.gender) patch.gender = input.gender;
        if (input.isPohangResident !== undefined) patch.isPohangResident = input.isPohangResident;
        if (input.privacyAgreedAt) patch.privacyAgreedAt = input.privacyAgreedAt;
        if (input.phoneVerifiedAt) patch.phoneVerifiedAt = input.phoneVerifiedAt;

        await updateFirestoreDoc("users", match.id, patch);
        const final = { ...match, ...patch } as User;
        setCurrentUser(final);
        showToast(t("store.welcome", undefined, { name: final.name }), "success");
        return final;
      }

      // signInOnly 모드: 기존 계정 없으면 가입 거부
      if (input.signInOnly) {
        throw new Error("일치하는 계정이 없습니다. 신규 가입 모드에서 등록해 주세요.");
      }

      // 3) new user
      const newId = generateId();
      const user: User = {
        id: newId,
        role,
        name,
        phone,
        status: "active",
        authType: input.authType ?? (socialProvider ? socialProvider : "phone"),
      };
      if (role === "owner") {
        user.restaurantName = restaurantName;
        if (input.posVendor) user.posVendor = input.posVendor;
        if (input.posApiKey) user.posApiKey = input.posApiKey;
      }
      // customer는 storeId 없이 전역 계정으로 생성 (방문은 visits 컬렉션에 storeId 별도 저장)
      void storeId;
      if (socialId && socialProvider) {
        user.socialIds = [socialId];
        user.linkedProviders = [socialProvider];
        if (socialProvider === "google") user.googleId = socialId;
        if (socialProvider === "kakao") user.kakaoId = socialId;
      }
      if (input.avatarUrl) user.avatarUrl = input.avatarUrl;
      if (input.birthYear) {
        user.birthYear = input.birthYear;
        user.ageGroup = calculateAgeGroup(input.birthYear);
      }
      if (input.birthday) user.birthday = input.birthday;
      if (input.gender) user.gender = input.gender;
      if (input.isPohangResident !== undefined) user.isPohangResident = input.isPohangResident;
      if (input.privacyAgreedAt) user.privacyAgreedAt = input.privacyAgreedAt;
      if (input.phoneVerifiedAt) user.phoneVerifiedAt = input.phoneVerifiedAt;

      await updateFirestoreDoc("users", newId, user);

      // Owner: auto-create 15 tables
      if (role === "owner" && db) {
        const batch = writeBatch(db);
        for (const t of makeDefaultTables(newId)) {
          batch.set(doc(db, "tables", t.id), t);
        }
        try {
          await batch.commit();
        } catch (e) {
          console.error("[create tables]", e);
        }
      }

      setCurrentUser(user);
      showToast(t("store.welcome", undefined, { name }), "success");
      return user;
    },
    [users, setCurrentUser]
  );

  const logout = useCallback(() => {
    setCurrentUser(null);
    // 계정 전환 시 이전 매장 데이터가 다음 유저 화면에 잠깐 노출되지 않도록 scoped 상태를 비움.
    // (scoped 리스너는 currentUser=null 이면 early-return 하므로 자동으로는 비워지지 않음)
    setVisits([]);
    setCoupons([]);
    setTables([]);
    setSections([]);
    setCommunications([]);
    setTierOverrides([]);
    setMenus([]);
    setOrders([]);
    setReservations([]);
    setPhotos([]);
    setShifts([]);
    setIngredients([]);
    setExpenses([]);
    setMarketingDrafts([]);
    showToast(t("store.loggedOut"), "info");
  }, [setCurrentUser]);

  const deleteAccount = useCallback(async () => {
    if (!currentUser) return;
    await updateFirestoreDoc("users", currentUser.id, {
      status: "deleted",
      name: "삭제된 계정",
      phone: "",
      googleId: null,
      kakaoId: null,
      socialIds: [],
    });
    logout();
  }, [currentUser, logout]);

  const setMasterPassword = useCallback(async (pw: string) => {
    await updateFirestoreDoc("appState", "settings", { masterPassword: pw });
    setMasterPasswordState(pw);
    showToast(t("store.master.pwChanged"), "success");
  }, []);

  /** SMS 인증 완료 후 users 문서에 phoneVerifiedAt 마킹 + 인증한 번호 동기화. */
  const markPhoneVerified = useCallback(async (userId: string, e164Phone?: string) => {
    const patch: Partial<User> = {
      phoneVerifiedAt: new Date().toISOString(),
    };
    if (e164Phone) patch.phone = e164Phone;
    // write 전 익명 토큰 보장 — 전화인증(signOut) 직후 토큰 미회복 시 permission-denied 로
    // phoneVerifiedAt 저장이 실패해 재인증이 반복되던 버그를 차단.
    await ensureAnonymousAuth();
    await updateFirestoreDoc("users", userId, patch);
    // 로컬 currentUser 도 즉시 반영 — 안 하면 새로고침 시 인증 게이트가 다시 떠 재인증(SMS 비용) 발생
    const cu = currentUserRef.current;
    if (cu?.id === userId) setCurrentUser({ ...cu, ...patch });
  }, [setCurrentUser]);

  const loginMaster = useCallback(
    (pw: string) => {
      if (pw === masterPassword) {
        setIsMaster(true);
        localStorage.setItem(LS_MASTER, "1");
        showToast(t("store.master.loginOk"), "success");
        return true;
      }
      showToast(t("store.master.pwWrong"), "error");
      return false;
    },
    [masterPassword]
  );

  const logoutMaster = useCallback(() => {
    setIsMaster(false);
    localStorage.removeItem(LS_MASTER);
  }, []);

  const deleteUser = useCallback(
    async (userId: string, role: Role) => {
      if (!db) {
        showToast(t("store.master.offlineDelete"), "error");
        return;
      }
      const batch = writeBatch(db);
      const cascade = async (
        coll: string,
        field: string,
        value: string
      ) => {
        const snap = await import("firebase/firestore").then(({ getDocs, query, where, collection }) =>
          getDocs(query(collection(db!, coll), where(field, "==", value)))
        );
        snap.forEach((d) => batch.delete(d.ref));
      };

      if (role === "owner") {
        await cascade("tables", "storeId", userId);
        await cascade("visits", "storeId", userId);
        await cascade("coupons", "storeId", userId);
        await cascade("Communications", "storeId", userId);
        await cascade("tierOverrides", "storeId", userId);
        await cascade("sections", "storeId", userId);
        await cascade("menus", "storeId", userId);
        await cascade("orders", "storeId", userId);
        await cascade("reservations", "storeId", userId);
        await cascade("photos", "storeId", userId);
        await cascade("shifts", "storeId", userId);
      } else if (role === "staff") {
        await cascade("shifts", "staffId", userId);
      } else {
        await cascade("visits", "customerId", userId);
        await cascade("coupons", "customerId", userId);
        await cascade("Communications", "customerId", userId);
        await cascade("tierOverrides", "customerId", userId);
      }
      batch.delete(doc(db, "users", userId));
      await batch.commit();
      showToast(t("store.master.deleted"), "success");
    },
    []
  );

  // ============ VISITS ============
  const recordVisit = useCallback(
    async (customerId: string, tableNumber: number, storeId: string, amount?: number) => {
      // 10초 디바운스
      const guardKey = `gyeol:last_visit_${customerId}_${storeId}`;
      const last = Number(sessionStorage.getItem(guardKey) || 0);
      if (Date.now() - last < 10_000) return;
      sessionStorage.setItem(guardKey, String(Date.now()));

      // ref로 최신 스냅샷 읽어 identity 안정화
      const users = usersRef.current;
      const visits = visitsRef.current;
      const coupons = couponsRef.current;
      const tables = tablesRef.current;
      const currentUser = currentUserRef.current;

      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const today = new Date().toDateString();
      const alreadyToday = visits.some(
        (v) =>
          v.customerId === customerId &&
          v.storeId === storeId &&
          new Date(v.date).toDateString() === today
      );

      // 1) Create visit (only once per day)
      if (!alreadyToday) {
        const visit: Visit = {
          id: generateId(),
          customerId,
          storeId,
          tableNumber,
          date: new Date().toISOString(),
          totalAmount: amount,
        };
        await updateFirestoreDoc("visits", visit.id, visit);

        // Reward accrual (Firestore increment으로 atomic 처리)
        if (owner?.storeConfig) {
          const cfg = owner.storeConfig;
          let delta = 0;
          if (cfg.rewardType === "stamp") {
            delta = 1;
          } else if (cfg.rewardType === "point") {
            const rate = cfg.pointRate ?? 0.05;
            const base = amount ?? 10000;
            delta = Math.floor(base * rate);
          }
          if (delta > 0) {
            await updateFirestoreDoc("users", customerId, {
              rewardBalance: increment(delta),
            });
            // 로컬 currentUser도 즉시 반영 (UI stale 방지)
            if (currentUser?.id === customerId) {
              setCurrentUser({
                ...currentUser,
                rewardBalance: (currentUser.rewardBalance ?? 0) + delta,
              });
            }
          }
        }

        // 2) Tier coupons
        const myVisits = [
          ...visits.filter((v) => v.customerId === customerId && v.storeId === storeId),
          visit,
        ];
        const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
        const uniqueDays = new Set(
          myVisits
            .filter((v) => new Date(v.date).getTime() >= thirtyDaysAgo)
            .map((v) => new Date(v.date).toDateString())
        ).size;

        const tierRules: { min: number; tier: Tier; descKey: string }[] = [
          { min: 12, tier: "VIP", descKey: "coupon.reward.vip" },
          { min: 8, tier: "다이아", descKey: "coupon.reward.diamond" },
          { min: 6, tier: "골드", descKey: "coupon.reward.gold" },
          { min: 4, tier: "실버", descKey: "coupon.reward.silver" },
          { min: 2, tier: "브론즈", descKey: "coupon.reward.bronze" },
        ];
        for (const rule of tierRules) {
          if (uniqueDays >= rule.min) {
            const already = coupons.some(
              (c) => c.customerId === customerId && c.storeId === storeId && c.type === rule.tier
            );
            if (!already) {
              // 사장님이 보상을 커스텀했으면 그 문자열(사장님 언어 그대로), 아니면 descKey 를 저장해
              // 표시 시점에 t(descKey, 고객언어) 로 변환 → 비한국어 고객도 모국어로 쿠폰을 봄.
              const custom = owner?.tierRewards?.[rule.tier];
              const c: Coupon = {
                id: generateId(),
                customerId,
                storeId,
                type: rule.tier,
                description: custom ?? t(rule.descKey, "ko"),
                ...(custom ? {} : { descKey: rule.descKey }),
                status: "available",
                issuedAt: new Date().toISOString(),
              };
              await updateFirestoreDoc("coupons", c.id, c);
            }
            break;
          }
        }
      }

      // 3) Table state — 사장이 인쇄한 QR이면 정식 테이블로 자동 생성
      const tableId = `${storeId}_${tableNumber}`;
      const existing = tables.find((t) => t.id === tableId);
      if (existing) {
        await updateFirestoreDoc("tables", tableId, {
          currentCustomerId: customerId,
          sessionStartTime: new Date().toISOString(),
          status: "occupied",
        });
      } else {
        // 없는 번호로 들어오면 새 테이블 doc 생성 (없으면 myTable이 영원히 안 잡혀 손님이 "테이블 이용" 메시지를 계속 봄)
        const num = Number(tableNumber);
        const col = ((num - 1) % 5 + 5) % 5;
        const row = Math.max(0, Math.floor((num - 1) / 5));
        await updateFirestoreDoc("tables", tableId, {
          id: tableId,
          number: num,
          storeId,
          type: "table",
          shape: "square",
          seats: 4,
          width: 90,
          height: 90,
          x: col * 120 + 40,
          y: row * 120 + 40,
          status: "occupied",
          currentCustomerId: customerId,
          sessionStartTime: new Date().toISOString(),
        });
      }

      if (!alreadyToday) showToast(t("store.visitRecorded"), "success");
    },
    [setCurrentUser]
  );

  const leaveTable = useCallback(async (tableNumber: number, storeId: string) => {
    const tableId = `${storeId}_${tableNumber}`;
    await updateFirestoreDoc("tables", tableId, {
      currentCustomerId: null,
      occupantIds: [],
      currentCustomerName: null,
      partySize: null,
      sessionStartTime: null,
      status: "dirty",
    });
  }, []);

  /**
   * 손님이 QR 로 매장 진입 — 테이블 점유 시작.
   * 이미 점유 상태면 추가 손님으로 occupantIds 에 합석.
   * 호출처: customer/TableEntry.tsx (또는 customer/Dashboard.tsx 진입 시점)
   */
  const enterTable = useCallback(
    async (input: {
      tableNumber: number;
      storeId: string;
      customerId: string;
      customerName?: string;
      partySize?: number;
    }) => {
      const tableId = `${input.storeId}_${input.tableNumber}`;
      const existing = tablesRef.current.find((t) => t.id === tableId);
      const occupantIds = Array.from(
        new Set([...(existing?.occupantIds ?? []), input.customerId])
      );
      // 8단계 자동 전이 — 현재 status 가 setup/reserved/available 이었으면 occupied 로
      // 이미 occupied/dining/paid 면 유지 (합석/주문 후 점유 갱신)
      const cur = existing?.status;
      const nextStatus =
        cur === "dining" || cur === "paid" || cur === "cleaning" || cur === "dirty"
          ? cur
          : "occupied";
      await updateFirestoreDoc("tables", tableId, {
        currentCustomerId: existing?.currentCustomerId ?? input.customerId,
        currentCustomerName: existing?.currentCustomerName ?? input.customerName ?? null,
        occupantIds,
        partySize: input.partySize ?? existing?.partySize ?? occupantIds.length,
        sessionStartTime: existing?.sessionStartTime ?? new Date().toISOString(),
        status: nextStatus,
      });
    },
    []
  );

  /**
   * 사장님이 손님을 강제 퇴장 처리.
   * 미결제 주문은 cancelled 로 정리 (집계 보호) 후 테이블 정리.
   */
  const evictTable = useCallback(
    async (tableNumber: number, storeId: string) => {
      const tableId = `${storeId}_${tableNumber}`;
      const unpaid = ordersRef.current.filter(
        (o) => o.storeId === storeId && o.tableNumber === tableNumber && o.paymentStatus !== "paid"
      );
      // 미결제 주문 cancel — batch 로 묶어 all-or-nothing 보장.
      // 기존엔 개별 try/catch 로 부분 실패해도 진행 → 유령 pending 주문이
      // 매출 집계/재고 카운트에 영구히 남던 무결성 버그.
      if (db && unpaid.length > 0) {
        const batch = writeBatch(db);
        for (const o of unpaid) {
          batch.set(doc(db, "orders", o.id), { status: "cancelled" }, { merge: true });
        }
        batch.set(doc(db, "tables", tableId), {
          currentCustomerId: null,
          occupantIds: [],
          currentCustomerName: null,
          partySize: null,
          sessionStartTime: null,
          status: "dirty",
        }, { merge: true });
        await batch.commit();
        // 취소된 미결제 주문의 재고 복구(+1) — placeOrder 에서 차감했으므로 반대로. 이미 취소된 건 제외(중복 방지).
        const toRestore = unpaid.filter((o) => o.status !== "cancelled");
        if (toRestore.length > 0) {
          adjustStockForOrder(toRestore.flatMap((o) => o.items), +1).catch((e) => console.warn("[evictTable] stock restore failed", e?.message));
        }
      } else {
        await updateFirestoreDoc("tables", tableId, {
          currentCustomerId: null,
          occupantIds: [],
          currentCustomerName: null,
          partySize: null,
          sessionStartTime: null,
          status: "dirty",
        });
      }
      showToast(t("store.tableEvicted", undefined, { n: tableNumber }), "success");
    },
    []
  );

  // ============ COUPONS ============
  const issueCoupon = useCallback(
    async (customerId: string, storeId: string, type: string, description: string, amount?: number, opts?: { silent?: boolean; descKey?: string }) => {
      const amt = Math.max(0, Math.round(Number(amount) || 0));
      const c: Coupon = {
        id: generateId(),
        customerId,
        storeId,
        type,
        description,
        ...(amt > 0 ? { amount: amt } : {}), // 금액 쿠폰(8-7)
        ...(opts?.descKey ? { descKey: opts.descKey } : {}), // i18n 키 — 손님 언어로 번역 표시(#8/#20)
        status: "available",
        issuedAt: new Date().toISOString(),
      };
      await updateFirestoreDoc("coupons", c.id, c);
      // 자동 보상(손님 기기)에선 발급자 시점 토스트 억제 — 도착 알림(coupons.arrived)으로 일원화
      if (!opts?.silent) showToast(t("store.coupon.issued"), "success");
    },
    []
  );

  const requestCouponUse = useCallback(async (couponId: string, tableNumber?: number) => {
    await updateFirestoreDoc("coupons", couponId, {
      status: "pending",
      usedAtTable: tableNumber ?? null,
    });
    // 쿠폰의 매장(storeId) 으로 사장님 푸시
    const c = couponsRef.current.find((x) => x.id === couponId);
    if (c?.storeId) {
      const ownerLang = usersRef.current.find((u) => u.id === c.storeId)?.lang ?? "ko";
      const couponDesc = c.description ?? t("gnotif.coupon.descFallback", ownerLang);
      sendOwnerPush({
        storeId: c.storeId,
        kind: "coupon-request",
        title: t("gnotif.coupon.title", ownerLang),
        body: tableNumber
          ? t("gnotif.coupon.bodyTable", ownerLang, { desc: couponDesc, table: tableNumber })
          : t("gnotif.coupon.body", ownerLang, { desc: couponDesc }),
        focusUrl: "/biz/owner/orders",
        tag: "gyeol-coupon",
      });
    }
    showToast(t("store.coupon.requested"), "info");
  }, []);

  const cancelCouponRequest = useCallback(async (couponId: string) => {
    await updateFirestoreDoc("coupons", couponId, {
      status: "available",
      usedAtTable: null,
    });
    showToast(t("store.coupon.requestCancelled"), "info");
  }, []);

  const approveCouponUse = useCallback(async (couponId: string) => {
    const c = couponsRef.current.find((x) => x.id === couponId);
    // 8-7: 금액 쿠폰이면 그 테이블 계산서에 할인 라인(−금액)을 추가 → approvePayment 합산 시 자동 차감.
    // status !== 'used' 가드 — 이미 사용된 쿠폰 재승인 시 할인 중복 생성 방지.
    if (c && c.status !== "used" && (c.amount ?? 0) > 0 && c.usedAtTable != null) {
      const billTotal = ordersRef.current
        .filter((o) => o.storeId === c.storeId && o.tableNumber === c.usedAtTable && o.status !== "cancelled" && o.paymentStatus !== "paid")
        .reduce((s, o) => s + o.totalAmount, 0);
      const discount = Math.min(c.amount!, Math.max(0, billTotal)); // 계산서 초과 차감 방지
      if (discount <= 0) {
        showToast(t("store.coupon.noBill"), "error"); // 차감할 미결제 금액이 없음
        return;
      }
      const discountOrder: Order = {
        // 쿠폰 기반 결정적 id — 더블클릭·다중 디바이스 동시 승인 시 같은 문서를 덮어써(merge) 할인 라인 중복 생성 원천 차단
        id: `COUPONDISC_${couponId}`,
        storeId: c.storeId,
        tableNumber: c.usedAtTable,
        customerId: c.customerId,
        items: [{ menuId: "", name: t("store.coupon.discountLine"), quantity: 1, price: -discount }],
        totalAmount: -discount,
        status: "served", // 주방·활성주문 흐름에서 제외
        paymentStatus: "unpaid", // 테이블 결제 시 함께 paid 처리
        createdAt: new Date().toISOString(),
      };
      await updateFirestoreDoc("orders", discountOrder.id, discountOrder);
    }
    await updateFirestoreDoc("coupons", couponId, {
      status: "used",
      usedAt: new Date().toISOString(),
    });
    showToast(t("store.coupon.approved"), "success");
  }, []);

  const rejectCouponUse = useCallback(async (couponId: string) => {
    await updateFirestoreDoc("coupons", couponId, {
      status: "available",
      usedAtTable: null,
    });
    showToast(t("store.coupon.rejected"), "info");
  }, []);

  // ============ TABLES ============
  const addTable = useCallback(
    async (storeId: string, type: TableDoc["type"] = "table", sectionId?: string) => {
      const storeTables = tables.filter((t) => t.storeId === storeId);
      const nextNumber = storeTables.reduce((mx, t) => Math.max(mx, t.number), 0) + 1;
      const isRoom = type === "room";
      const t: TableDoc = {
        id: `${storeId}_${nextNumber}`,
        number: nextNumber,
        storeId,
        type,
        x: 40,
        y: 40,
        width: isRoom ? 150 : 70,
        height: isRoom ? 80 : 70,
        seats: isRoom ? 6 : 4,
        shape: "square",
        status: "available",
        sectionId,
      };
      await updateFirestoreDoc("tables", t.id, t);
    },
    [tables]
  );

  const updateTableLayout = useCallback(
    async (storeId: string, number: number, data: Partial<TableDoc>) => {
      await updateFirestoreDoc("tables", `${storeId}_${number}`, data);
    },
    []
  );

  const deleteTable = useCallback(async (storeId: string, number: number) => {
    await updateFirestoreDoc("tables", `${storeId}_${number}`, undefined, true);
  }, []);

  const updateTableStatus = useCallback(
    async (storeId: string, number: number, status: TableStatus) => {
      const patch: Partial<TableDoc> = { status };
      // 비어있음으로 복귀 시 점유 정보 일괄 정리
      if (status === "available") {
        patch.currentCustomerId = null;
        patch.currentCustomerName = null;
        patch.occupantIds = [];
        patch.partySize = null;
        patch.sessionStartTime = null;
      }
      await updateFirestoreDoc("tables", `${storeId}_${number}`, patch);
    },
    []
  );

  const initTables = useCallback(async (storeId: string) => {
    if (!db) return;
    const batch = writeBatch(db);
    tables.filter((t) => t.storeId === storeId).forEach((t) => batch.delete(doc(db!, "tables", t.id)));
    for (const t of makeDefaultTables(storeId)) {
      batch.set(doc(db, "tables", t.id), t);
    }
    await batch.commit();
    showToast(t("store.tables.reset"), "success");
  }, [tables]);

  // ============ SECTIONS ============
  const addSection = useCallback(async (storeId: string, name: string) => {
    const id = generateId();
    const order = sections.filter((s) => s.storeId === storeId).length;
    await updateFirestoreDoc("sections", id, { id, storeId, name, order });
  }, [sections]);

  const updateSection = useCallback(async (id: string, data: Partial<Section>) => {
    await updateFirestoreDoc("sections", id, data);
  }, []);

  const deleteSection = useCallback(async (id: string) => {
    await updateFirestoreDoc("sections", id, undefined, true);
    // unassign tables in that section
    const targets = tables.filter((t) => t.sectionId === id);
    for (const t of targets) {
      await updateFirestoreDoc("tables", t.id, { sectionId: null });
    }
  }, [tables]);

  // ============ MENUS ============
  const addMenuItem = useCallback(async (storeId: string, data: Omit<Menu, "id" | "storeId">, silent?: boolean) => {
    const id = generateId();
    await updateFirestoreDoc("menus", id, { id, storeId, ...data });
    if (!silent) showToast(t("store.menu.added"), "success"); // 메뉴판 일괄 등록은 silent 로 요약 토스트 1개만
  }, []);

  const updateMenuItem = useCallback(async (id: string, data: Partial<Menu>) => {
    await updateFirestoreDoc("menus", id, data);
  }, []);

  const deleteMenuItem = useCallback(async (id: string) => {
    await updateFirestoreDoc("menus", id, undefined, true);
  }, []);

  // ============ INGREDIENTS ============
  const addIngredient = useCallback(
    async (storeId: string, data: Omit<Ingredient, "id" | "storeId" | "updatedAt">) => {
      const id = generateId();
      const doc: Ingredient = {
        id,
        storeId,
        ...data,
        updatedAt: new Date().toISOString(),
      };
      await updateFirestoreDoc("ingredients", id, doc);
    },
    []
  );

  const updateIngredient = useCallback(
    async (id: string, data: Partial<Ingredient>) => {
      await updateFirestoreDoc("ingredients", id, {
        ...data,
        updatedAt: new Date().toISOString(),
      });
    },
    []
  );

  const deleteIngredient = useCallback(async (id: string) => {
    await updateFirestoreDoc("ingredients", id, undefined, true);
  }, []);

  const addExpense = useCallback(
    async (storeId: string, data: Omit<Expense, "id" | "storeId" | "createdAt">) => {
      const id = generateId();
      const docData: Expense = { id, storeId, createdAt: new Date().toISOString(), ...data };
      await updateFirestoreDoc("expenses", id, docData);
    },
    []
  );
  const deleteExpense = useCallback(async (id: string) => {
    await updateFirestoreDoc("expenses", id, undefined, true);
  }, []);

  // ===== 마케팅 에이전트 초안 (TODO 7-3) — 승인 게이트 + 감사 로깅 =====
  const addMarketingDraft = useCallback(
    async (
      storeId: string,
      data: Pick<MarketingDraft, "channel" | "kind" | "content"> & {
        title?: string;
        source?: MarketingDraft["source"];
        targetId?: string;
        targetSummary?: string;
      }
    ) => {
      const id = generateId();
      const now = new Date().toISOString();
      const by = currentUserRef.current?.id;
      const draft: MarketingDraft = {
        id,
        storeId,
        channel: data.channel,
        kind: data.kind,
        title: data.title,
        content: data.content,
        status: "draft", // 항상 초안으로 — 자동 발행 금지(승인 필수)
        source: data.source ?? "manual",
        targetId: data.targetId,
        targetSummary: data.targetSummary,
        createdAt: now,
        audit: [{ at: now, action: "created", by }],
      };
      await updateFirestoreDoc("marketingDrafts", id, draft);
    },
    []
  );
  const reviewMarketingDraft = useCallback(
    async (id: string, action: "approve" | "reject" | "publish", note?: string) => {
      const cur = marketingDraftsRef.current.find((d) => d.id === id);
      if (!cur) return;
      const now = new Date().toISOString();
      const by = currentUserRef.current?.id;
      const status: MarketingDraft["status"] =
        action === "approve" ? "approved" : action === "reject" ? "rejected" : "published";
      // arrayUnion 으로 atomic append — 동시/멀티기기 쓰기에서도 로그 항목 유실 방지. (sentinel 내부는
      // stripUndefined 가 정리하지 않으므로 undefined 키를 넣지 않도록 조건부 구성)
      const entry: Record<string, string> = { at: now, action };
      if (by) entry.by = by;
      if (note?.trim()) entry.note = note.trim();
      const patch: Partial<MarketingDraft> = {
        status,
        reviewedAt: now,
        audit: arrayUnion(entry) as any,
      };
      if (action === "publish") patch.publishedAt = now;
      await updateFirestoreDoc("marketingDrafts", id, patch);
    },
    []
  );
  const updateMarketingDraftContent = useCallback(async (id: string, content: string, title?: string) => {
    const cur = marketingDraftsRef.current.find((d) => d.id === id);
    if (!cur) return;
    const now = new Date().toISOString();
    const by = currentUserRef.current?.id;
    const entry: Record<string, string> = { at: now, action: "edited" };
    if (by) entry.by = by;
    await updateFirestoreDoc("marketingDrafts", id, {
      content,
      title,
      audit: arrayUnion(entry) as any,
    });
  }, []);
  const deleteMarketingDraft = useCallback(async (id: string) => {
    await updateFirestoreDoc("marketingDrafts", id, undefined, true);
  }, []);

  /**
   * 주문 항목 기반으로 원재료 재고를 일괄 차감/복원.
   * direction: -1 = 차감(판매), +1 = 복원(주문 취소).
   * menus.recipe 의 quantityPerServing × orderItem.quantity 만큼 ingredient.stock 변동.
   *
   * 동시성 안전: Firestore increment() 서버측 atomic 연산 사용.
   * read-modify-write 가 아니라 서버에서 직접 +/- 가 적용되므로
   * 두 테이블 동시 주문이 같은 원재료를 차감해도 손실 없음.
   * 음수 클램프(stock 이 0 미만으로 안 가게)는 서버 sentinel 로 불가능 →
   * 추후 Cloud Function 트리거 또는 룰에서 검증. 클라이언트 표시 시 Math.max(0, ...) 폴백.
   */
  const adjustStockForOrder = useCallback(
    async (items: OrderItem[], direction: -1 | 1) => {
      const menusList = menusRef.current;
      // 같은 원재료가 여러 메뉴에 걸쳐 나오면 누적
      const deltaMap = new Map<string, number>();
      for (const it of items) {
        const menu = menusList.find((m) => m.id === it.menuId);
        if (!menu) continue;
        // 기본 레시피 + 선택된 옵션의 레시피(곱빼기 등) 모두 차감
        const recipes: { ingredientId: string; quantity: number }[] = [...(menu.recipe ?? [])];
        if (it.selectedOptions?.length && menu.optionGroups) {
          for (const so of it.selectedOptions) {
            const opt = menu.optionGroups.find((g) => g.id === so.groupId)?.options.find((o) => o.id === so.optionId);
            if (opt?.recipe) recipes.push(...opt.recipe);
          }
        }
        for (const r of recipes) {
          const cur = deltaMap.get(r.ingredientId) ?? 0;
          deltaMap.set(r.ingredientId, cur + r.quantity * it.quantity * direction);
        }
      }
      // Firestore atomic increment 로 일괄 갱신 — race 안전
      const updates: Promise<void>[] = [];
      for (const [ingId, delta] of deltaMap) {
        if (delta === 0) continue;
        updates.push(
          updateFirestoreDoc("ingredients", ingId, {
            stock: increment(delta),
            updatedAt: new Date().toISOString(),
          } as any)
        );
      }
      await Promise.all(updates);
    },
    []
  );

  // ============ ORDERS ============
  const placeOrder = useCallback(
    async ({
      storeId,
      tableNumber,
      customerId,
      items,
      manual,
    }: {
      storeId: string;
      tableNumber: number;
      customerId: string;
      items: OrderItem[];
      manual?: boolean;
    }): Promise<Order> => {
      // 영업 시간 검증 — 영업 외 시간이거나 임시 마감이면 손님 셀프 주문(키오스크 포함) 차단.
      // 단 사장/직원이 카운터에서 직접 입력하는 수동 주문(manual)은 영업 준비·마감 정리 중에도
      // 받을 수 있어야 하므로 검증을 건너뛴다 (실매장 POS 동작과 일치).
      if (!manual) {
        const ownerForCheck = usersRef.current.find((u) => u.id === storeId && u.role === "owner");
        const status = getStoreOpenStatus(ownerForCheck);
        if (status.open === false) {
          const msg = status.reason;
          showToast(t("store.order.cannot", undefined, { msg }), "error");
          throw new Error(msg);
        }
      }

      // 항목 입력 검증 — 음수·0 가격, 음수·0 수량 차단 (조작·실수 방어)
      if (!Array.isArray(items) || items.length === 0) {
        showToast(t("store.order.empty"), "error");
        throw new Error("empty items");
      }
      for (const it of items) {
        if (typeof it.price !== "number" || !Number.isFinite(it.price) || it.price <= 0) {
          showToast(t("store.order.invalidAmount"), "error");
          throw new Error("invalid price");
        }
        if (typeof it.quantity !== "number" || !Number.isFinite(it.quantity) || it.quantity <= 0 || it.quantity > 99) {
          showToast(t("store.order.invalidQty"), "error");
          throw new Error("invalid quantity");
        }
      }

      // 강제 퇴장 race 방어 — 사장님이 직전에 evictTable 했으면 손님은 그 테이블에 없음
      const tableId = `${storeId}_${tableNumber}`;
      const tableNow = tablesRef.current.find((t) => t.id === tableId);
      const isCustomer = currentUser?.role === "customer";
      if (isCustomer && tableNow && tableNow.currentCustomerId && tableNow.currentCustomerId !== customerId &&
          !(tableNow.occupantIds ?? []).includes(customerId)) {
        showToast(t("store.order.tableCleared"), "error");
        throw new Error("table not occupied by this customer");
      }

      const totalAmount = items.reduce((s, it) => s + it.price * it.quantity, 0);
      const order: Order = {
        id: generateId(),
        storeId,
        tableNumber,
        customerId,
        items,
        totalAmount,
        status: "pending",
        paymentStatus: "unpaid",
        createdAt: new Date().toISOString(),
      };
      await updateFirestoreDoc("orders", order.id, order);

      // 8단계 자동 전이 — 주문이 발생하면 테이블 상태 dining 으로 (occupied/setup/available 일 때만)
      try {
        const tableId = `${storeId}_${tableNumber}`;
        const cur = tablesRef.current.find((t) => t.id === tableId);
        const curStatus = cur?.status;
        if (curStatus === "occupied" || curStatus === "setup" || curStatus === "available" || !curStatus) {
          await updateFirestoreDoc("tables", tableId, { status: "dining" });
        }
      } catch (e: any) {
        console.warn("[placeOrder] status→dining skip", e?.message);
      }

      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const hasPosApi =
        owner?.posVendor && owner.posVendor !== "none" && owner.posApiKey;

      // 사장님 디바이스 푸시 — 새 주문 도착
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId,
        kind: "new-order",
        title: t("gnotif.newOrder.title", ownerLang, { table: tableNumber }),
        body: t("gnotif.newOrder.body", ownerLang, { count: items.length, amount: fmtKRW(totalAmount, ownerLang) }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-order-T${tableNumber}`,
      });

      // ⚠️ 주문 시점에는 영수증 인쇄하지 않음 (정책 변경 — 2026-06).
      //   영수증은 결제 승인 시점에 '총 영수증' 한 번만 출력.
      //   POS API 연동만 즉시 호출 (주방 전달 등 매장 운영에 필요).
      if (hasPosApi || owner?.foodtechStoreCode) {
        const apiKey = owner?.posApiKey || owner?.foodtechStoreCode || "";
        const ok = await relayOrderToPos(
          apiKey,
          order,
          (mid) => menus.find((m) => m.id === mid)?.posProductCode,
          owner?.posVendor
        );
        if (!ok) {
          console.warn("[POS relay] failed — manual handling needed");
        }
      }
      // 영수증 인쇄(①②③④) 는 모두 결제 승인 시점(approvePayment) 으로 이동.
      // 손님이 중간에 영수증을 원하면 BillModal 의 '계산서 보기' 로 확인 가능.

      // 재고 자동 차감 — 메뉴.recipe 가 등록된 경우만. 실패해도 주문 자체는 진행.
      adjustStockForOrder(items, -1).catch((e) => {
        console.warn("[ingredients] adjust failed", e);
      });

      showToast(t("store.order.placed"), "success");
      return order;
    },
    [users, menus]
  );

  const updateOrderStatus = useCallback(async (id: string, status: OrderStatus) => {
    // 취소로 전환 시 주문 시점에 차감한 재고 복구(+1). 이미 취소된 주문은 중복 복구 방지.
    if (status === "cancelled") {
      const order = ordersRef.current.find((o) => o.id === id);
      if (order && order.status !== "cancelled") {
        adjustStockForOrder(order.items, +1).catch((e) => console.warn("[cancel] stock restore failed", e?.message));
      }
    }
    await updateFirestoreDoc("orders", id, { status });
  }, []);

  /**
   * 손님이 '결제하기' — 결제 요청만 보냄. 실제 결제·영수증은 사장님 승인 시점에.
   * 미결제 주문들의 paymentStatus 를 'requested' 로 변경 + 테이블 표시는 유지.
   */
  const payTableSession = useCallback(
    async (customerId: string, storeId: string, tableNumber: number): Promise<number> => {
      const ordersNow = ordersRef.current;
      const unpaid = ordersNow.filter(
        (o) =>
          o.customerId === customerId &&
          o.storeId === storeId &&
          o.tableNumber === tableNumber && // 현재 테이블 주문만 — 다른 테이블 주문까지 결제되던 버그 방지
          o.status !== "cancelled" &&
          o.paymentStatus !== "paid"
      );
      if (unpaid.length === 0) {
        showToast(t("store.pay.noUnpaid"), "info");
        return 0;
      }
      const total = unpaid.reduce((s, o) => s + o.totalAmount, 0);

      if (!db) {
        for (const o of unpaid) {
          await updateFirestoreDoc("orders", o.id, { paymentStatus: "requested" });
        }
      } else {
        const batch = writeBatch(db);
        unpaid.forEach((o) => {
          batch.set(doc(db!, "orders", o.id), { paymentStatus: "requested" }, { merge: true });
        });
        await batch.commit();
      }

      // 사장님 디바이스 푸시 — 결제 요청
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId,
        kind: "payment-request",
        title: t("gnotif.payment.title", ownerLang, { table: tableNumber }),
        body: t("gnotif.payment.body", ownerLang, { amount: fmtKRW(total, ownerLang), count: unpaid.length }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-pay-T${tableNumber}`,
      });

      showToast(t("store.pay.requested", undefined, { amount: `₩ ${total.toLocaleString()}` }), "info");
      return total;
    },
    []
  );

  /**
   * 카드결제 성공 콜백 — 토스 successUrl(/pay/success)에서 호출.
   * 서버 confirm 으로 실제 결제를 확정한 뒤, 그 손님의 미결제 주문을 paid 로 전환하고
   * 사장님에게 '결제 완료' 푸시를 보낸다. (영수증 인쇄는 사장님 측 approvePayment 와 분리)
   */
  const confirmTossPayment = useCallback(
    async (params: {
      storeId: string;
      customerId: string;
      tableNumber: number;
      paymentKey: string;
      orderId: string;
      amount: number;
      orderIds: string[];
    }): Promise<void> => {
      // 1) 서버에서 토스 결제 승인 (실제 과금 확정)
      const res = await fetch(api("/api/payment/confirm"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentKey: params.paymentKey,
          orderId: params.orderId,
          amount: params.amount,
          storeId: params.storeId, // 매장별 시크릿 키로 confirm (멀티테넌트 정산)
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err?.error ?? "payment-confirm-failed");
      }

      // 2) 결제 시작 시점에 스냅샷한 주문만 paid 로 전환 (왕복 중 추가된 주문은 제외 — 과다 결제완료 방지)
      const targets = ordersRef.current.filter(
        (o) => params.orderIds.includes(o.id) && o.paymentStatus !== "paid"
      );
      if (db && targets.length > 0) {
        const batch = writeBatch(db);
        targets.forEach((o) =>
          batch.set(doc(db!, "orders", o.id), { paymentStatus: "paid", paymentMethod: "card" }, { merge: true })
        );
        // 현금 승인(approvePayment)과 동일하게 테이블도 'paid'(정리 대기)로 — 카드결제 후에도 사장님 테이블맵에 정리 신호가 뜨도록.
        const tableId = `${params.storeId}_${params.tableNumber}`;
        if (tablesRef.current.some((t) => t.id === tableId)) {
          batch.set(doc(db!, "tables", tableId), { status: "paid" }, { merge: true });
        }
        await batch.commit();
      }

      // 3) 사장님 디바이스로 '결제 완료' 푸시 (영수증 인쇄는 사장님 화면에서)
      const ownerLang = usersRef.current.find((u) => u.id === params.storeId)?.lang ?? "ko";
      sendOwnerPush({
        storeId: params.storeId,
        kind: "payment-request",
        title: t("gnotif.paid.title", ownerLang, { table: params.tableNumber }),
        body: t("gnotif.paid.body", ownerLang, { amount: fmtKRW(params.amount, ownerLang) }),
        focusUrl: "/biz/owner/orders",
        tag: `gyeol-paid-T${params.tableNumber}`,
      });
    },
    []
  );

  /**
   * 사장님이 '결제 승인' — 실제 결제 처리 + 총 영수증 인쇄.
   * - paymentStatus: requested|unpaid → paid
   * - 테이블 status: occupied → paid (정리 대기)
   * - 영수증 인쇄 ①POS → ②USB → ③팝업 → ④브릿지 큐 모두 시도
   *
   * 멱등성·중복 방지:
   *  - 같은 (storeId,tableNumber) 처리 중이면 즉시 0 반환 (2디바이스 동시 승인 차단)
   *  - 사장님 폰 + PC 동시 클릭 시에도 영수증 2장 출력 방지
   *  - Firestore 룰이 최종 방어선이지만 클라이언트 mutex 로 1차 차단
   */
  const approvePayment = useCallback(
    async (storeId: string, tableNumber: number): Promise<number> => {
      const lockKey = `${storeId}_${tableNumber}`;
      if (approvingPaymentRef.current.has(lockKey)) {
        showToast(t("store.pay.alreadyApproving"), "info");
        return 0;
      }
      approvingPaymentRef.current.add(lockKey);
      // 락은 try/finally 로 해제 — 기존 setTimeout(1500ms) 는 USB 프린터/네트워크가
      // 더 느릴 때 두 번째 클릭이 통과해 영수증 2장 출력되던 버그가 있었음.
      try {
        const ordersNow = ordersRef.current;
        const tablesNow = tablesRef.current;
        const targets = ordersNow.filter(
          (o) =>
            o.storeId === storeId &&
            o.tableNumber === tableNumber &&
            o.status !== "cancelled" &&
            o.paymentStatus !== "paid"
        );
        if (targets.length === 0) {
          showToast(t("store.pay.noRequest"), "info");
          return 0;
        }
        const total = targets.reduce((s, o) => s + o.totalAmount, 0);

        // 1) Firestore 일괄 업데이트: 주문 paid + 테이블 status: paid
        if (db) {
          const batch = writeBatch(db);
          targets.forEach((o) => {
            batch.set(doc(db!, "orders", o.id), { paymentStatus: "paid", paymentMethod: "cash" }, { merge: true });
          });
          const tableId = `${storeId}_${tableNumber}`;
          if (tablesNow.some((t) => t.id === tableId)) {
            batch.set(doc(db, "tables", tableId), { status: "paid" }, { merge: true });
          }
          await batch.commit();
        } else {
          for (const o of targets) {
            await updateFirestoreDoc("orders", o.id, { paymentStatus: "paid", paymentMethod: "cash" });
          }
        }

        // 2) 총 영수증 1장 — 모든 주문 항목 합쳐서
        const owner = users.find((u) => u.id === storeId && u.role === "owner");
        const aggregated: Order = {
          id: `RECEIPT_${storeId}_${tableNumber}_${Date.now()}`,
          storeId,
          tableNumber,
          customerId: targets[0].customerId,
          items: targets.flatMap((o) => o.items),
          totalAmount: total,
          status: "served",
          paymentStatus: "paid",
          createdAt: new Date().toISOString(),
        };
        const payload = {
          storeName: owner?.restaurantName ?? "결",
          order: aggregated,
          footer: t("receipt.footer.aggregated", getLanguage(), { table: tableNumber, count: targets.length }),
        };

        // 브릿지 큐 우선 (매장 PC 에이전트가 처리)
        let printedSomewhere = false;
        if (owner?.printBridgeEnabled) {
          try {
            await enqueuePrintJob({
              storeId, type: "receipt", payload, expectedUid: storeId,
            });
            printedSomewhere = true;
          } catch (e) {
            console.warn("[approvePayment] bridge enqueue failed", e);
          }
        }
        // USB → 팝업 폴백 (사장님 화면에서 호출되는 경우만)
        try {
          const printers = await getAuthorizedPrinters();
          if (printers.length > 0) {
            await printReceiptViaUsb(payload);
            printedSomewhere = true;
          } else {
            printReceipt(payload);
            printedSomewhere = true;
          }
        } catch (e: any) {
          try {
            printReceipt(payload);
            printedSomewhere = true;
          } catch {
            // 팝업도 차단됨 — 브릿지 큐도 실패했다면 출력 0장
          }
        }

        // 영수증 인쇄 실패 시 사장님에게 명시. 결제는 완료된 상태이므로
        // success 가 아닌 warning(info) 으로 — 다시 인쇄 안내.
        if (printedSomewhere) {
          showToast(t("store.pay.approved", undefined, { amount: `₩ ${total.toLocaleString()}` }), "success");
        } else {
          showToast(t("store.pay.printFailed", undefined, { amount: `₩ ${total.toLocaleString()}` }), "info");
        }
        return total;
      } finally {
        approvingPaymentRef.current.delete(lockKey);
      }
    },
    [users]
  );

  /**
   * 사장님 '계산 완료' — 테이블을 비어있음(available) 으로 정리.
   * occupant 정리 + status: available + sessionStartTime 초기화.
   * approvePayment 가 status: paid 로 둔 테이블에 대해 호출.
   */
  const completeTable = useCallback(async (storeId: string, tableNumber: number) => {
    const tableId = `${storeId}_${tableNumber}`;
    await updateFirestoreDoc("tables", tableId, {
      status: "available",
      currentCustomerId: null,
      currentCustomerName: null,
      occupantIds: [],
      partySize: null,
      sessionStartTime: null,
    });
    showToast(t("store.table.empty", undefined, { n: tableNumber }), "success");
  }, []);

  /** 선택 인쇄 — 사장님 또는 손님이 원할 때 즉시 영수증(합산 미리보기) 출력 */
  const printInterimReceipt = useCallback(
    async (storeId: string, tableNumber: number) => {
      const ordersNow = ordersRef.current;
      const open = ordersNow.filter(
        (o) =>
          o.storeId === storeId &&
          o.tableNumber === tableNumber &&
          o.status !== "cancelled"
      );
      if (open.length === 0) {
        showToast(t("store.receipt.noOrder"), "info");
        return;
      }
      const owner = users.find((u) => u.id === storeId && u.role === "owner");
      const total = open.reduce((s, o) => s + o.totalAmount, 0);
      const aggregated: Order = {
        id: `INTERIM_${storeId}_${tableNumber}_${Date.now()}`,
        storeId, tableNumber,
        customerId: open[0].customerId,
        items: open.flatMap((o) => o.items),
        totalAmount: total,
        status: "served",
        paymentStatus: "unpaid",
        createdAt: new Date().toISOString(),
      };
      const payload = {
        storeName: owner?.restaurantName ?? "결",
        order: aggregated,
        footer: t("receipt.footer.interim", getLanguage()),
      };
      if (owner?.printBridgeEnabled) {
        void enqueuePrintJob({ storeId, type: "receipt", payload, expectedUid: storeId });
      }
      try {
        const printers = await getAuthorizedPrinters();
        if (printers.length > 0) await printReceiptViaUsb(payload);
        else printReceipt(payload);
      } catch {
        try { printReceipt(payload); } catch { /* ignore */ }
      }
      showToast(t("store.receipt.interim"), "info");
    },
    [users]
  );

  // ============ CRM ============
  const recordCommunication = useCallback(
    async (
      customerId: string,
      storeId: string,
      type: "coupon" | "message",
      content: string,
      senderRole: "owner" | "customer" = "owner"
    ) => {
      const c: Communication = {
        id: generateId(),
        customerId,
        storeId,
        type,
        senderRole,
        content,
        date: new Date().toISOString(),
      };
      await updateFirestoreDoc("Communications", c.id, c);
    },
    []
  );

  const updateUserMemo = useCallback(async (userId: string, memo: string) => {
    await updateFirestoreDoc("users", userId, { memo });
  }, []);

  const setStaffWage = useCallback(async (userId: string, hourlyWage: number) => {
    await updateFirestoreDoc("users", userId, { hourlyWage });
  }, []);

  const setStaffLevel = useCallback(async (userId: string, level: StaffLevel) => {
    await updateFirestoreDoc("users", userId, { staffLevel: level });
  }, []);
  const setStaffPerms = useCallback(async (userId: string, perms: string[]) => {
    await updateFirestoreDoc("users", userId, { extraPerms: perms });
  }, []);

  const setCustomerTier = useCallback(
    async (customerId: string, storeId: string, tier: Tier | "auto") => {
      const id = `${customerId}_${storeId}`;
      if (tier === "auto") {
        await updateFirestoreDoc("tierOverrides", id, undefined, true);
      } else {
        await updateFirestoreDoc("tierOverrides", id, { customerId, storeId, tier });
      }
    },
    []
  );

  const bulkIssueCoupon = useCallback(
    async (customerIds: string[], storeId: string, type: string, description: string, amount?: number, descKey?: string) => {
      if (!db) return;
      const amt = Math.max(0, Math.round(Number(amount) || 0)); // 금액 쿠폰(8-7)
      // 이미 같은 종류의 미사용 쿠폰을 보유한 손님은 제외 — 재방문/연타 시 중복 발급 방지
      const existing = couponsRef.current;
      const targets = customerIds.filter(
        (cid) =>
          !existing.some(
            (c) =>
              c.customerId === cid &&
              c.storeId === storeId &&
              c.type === type &&
              c.status === "available"
          )
      );
      if (targets.length === 0) {
        showToast(t("store.bulkCouponNone"), "info");
        return;
      }
      const now = new Date().toISOString();
      // Firestore writeBatch 는 한 번에 최대 500 writes — 450개씩 나눠 커밋해 대형 매장에서 전량 실패 방지
      for (let i = 0; i < targets.length; i += 450) {
        const chunk = targets.slice(i, i + 450);
        const batch = writeBatch(db);
        for (const cid of chunk) {
          const id = generateId();
          batch.set(doc(db, "coupons", id), {
            id,
            customerId: cid,
            storeId,
            type,
            description,
            ...(amt > 0 ? { amount: amt } : {}),
            ...(descKey ? { descKey } : {}), // i18n 키 — 손님 언어로 번역 표시(#8)
            status: "available",
            issuedAt: now,
          });
        }
        await batch.commit();
      }
      showToast(t("store.bulkCoupon", undefined, { n: targets.length }), "success");
    },
    []
  );

  const updateBrandSettings = useCallback(async (storeId: string, data: Partial<User>) => {
    await updateFirestoreDoc("users", storeId, data);
    if (currentUser?.id === storeId) setCurrentUser({ ...currentUser, ...data });
  }, [currentUser, setCurrentUser]);

  const updateStoreConfig = useCallback(
    async (storeId: string, partial: Partial<NonNullable<User["storeConfig"]>>) => {
      const target = users.find((u) => u.id === storeId);
      const next = { ...(target?.storeConfig ?? {}), ...partial } as NonNullable<User["storeConfig"]>;
      await updateFirestoreDoc("users", storeId, { storeConfig: next });
      if (currentUser?.id === storeId) {
        setCurrentUser({ ...currentUser, storeConfig: next });
      }
    },
    [users, currentUser, setCurrentUser]
  );

  // 대기 탭의 미결제 주문을 실제 테이블로 이동 (구두주문 후 손님이 자리 잡으면)
  const moveOrdersTable = useCallback(
    async (storeId: string, fromTable: number, toTable: number) => {
      const targets = ordersRef.current.filter(
        (o) =>
          o.storeId === storeId &&
          o.tableNumber === fromTable &&
          o.status !== "cancelled" &&
          o.paymentStatus !== "paid"
      );
      for (const o of targets) {
        await updateFirestoreDoc("orders", o.id, { tableNumber: toTable });
      }
    },
    []
  );

  const updateStoreLocation = useCallback(
    async (storeId: string, lat: number, lng: number) => {
      await updateFirestoreDoc("users", storeId, { lat, lng });
      if (currentUser?.id === storeId) setCurrentUser({ ...currentUser, lat, lng });
    },
    [currentUser, setCurrentUser]
  );

  // ============ RESERVATIONS ============
  /**
   * 예약 → 테이블 자동 reserved 전이 정책 (2026-06).
   * - 예약 추가: 해당 테이블이 available/reserved 이면 reserved 로 변경.
   *   (이미 occupied/dining/paid/cleaning 인 경우엔 덮어쓰지 않음)
   * - 예약 취소/완료/노쇼/삭제: 해당 테이블이 reserved 이고 활성 예약이 더 없으면
   *   available 로 복귀. 손님이 이미 들어와 있으면 그대로 둠.
   */
  const _activeReservationsFor = (storeId: string, tableNumber: number, excludeId?: string) => {
    // 로컬(매장) 자정 기준 오늘 — toISOString 은 UTC라 KST 새벽엔 날짜가 하루 밀려
    // 어제 예약이 계속 활성으로 잡혀 테이블이 '예약됨'에서 안 풀리던 버그가 있었음.
    const n = new Date();
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    return reservationsRef.current.filter(
      (r) =>
        r.id !== excludeId &&
        r.storeId === storeId &&
        r.tableNumber === tableNumber &&
        r.status === "confirmed" &&
        r.date >= today
    );
  };

  const _refreshReservedForTable = useCallback(
    async (storeId: string, tableNumber: number, excludeId?: string) => {
      if (!storeId || !tableNumber) return;
      const tableId = `${storeId}_${tableNumber}`;
      const t = tablesRef.current.find((x) => x.id === tableId);
      if (!t) return;
      const still = _activeReservationsFor(storeId, tableNumber, excludeId).length > 0;
      // 현재 reserved 이고 더 이상 예약이 없으면 available 로 복귀
      if (t.status === "reserved" && !still) {
        await updateFirestoreDoc("tables", tableId, {
          status: "available",
          // 점유 정보는 안 건드림 (예약은 점유와 별개)
        });
      }
    },
    []
  );

  const addReservation = useCallback(
    async (
      input: Omit<Reservation, "id" | "createdAt" | "status"> & { status?: Reservation["status"] }
    ) => {
      const r: Reservation = {
        id: generateId(),
        createdAt: new Date().toISOString(),
        status: input.status ?? "confirmed",
        ...input,
      };
      await updateFirestoreDoc("reservations", r.id, r);

      // 8단계 자동 전이 — 예약 추가 시 테이블 reserved 로 (점유 중이면 보호)
      try {
        if (r.status === "confirmed") {
          const tableId = `${r.storeId}_${r.tableNumber}`;
          const t = tablesRef.current.find((x) => x.id === tableId);
          const cur = t?.status;
          // available 또는 setup, reserved 일 때만 reserved 로 (그 외는 보호)
          if (!cur || cur === "available" || cur === "setup" || cur === "reserved") {
            await updateFirestoreDoc("tables", tableId, { status: "reserved" });
          }
        }
      } catch (e: any) {
        console.warn("[addReservation] status→reserved skip", e?.message);
      }

      showToast(t("store.reservation.added"), "success");
    },
    []
  );

  const updateReservation = useCallback(async (id: string, data: Partial<Reservation>) => {
    const before = reservationsRef.current.find((r) => r.id === id);
    await updateFirestoreDoc("reservations", id, data);
    if (!before) return;
    const merged = { ...before, ...data };
    // 예약이 비활성화(cancelled/completed/no-show) 되었거나 다른 테이블·날짜로 이동했으면
    // 원래 테이블의 reserved 상태를 갱신해야 함.
    const becameInactive =
      before.status === "confirmed" && merged.status && merged.status !== "confirmed";
    const movedTable =
      merged.tableNumber !== undefined && merged.tableNumber !== before.tableNumber;
    if (becameInactive || movedTable) {
      await _refreshReservedForTable(before.storeId, before.tableNumber, id);
    }
    // 다른 테이블로 이동한 경우 새 테이블도 reserved 로 (활성 예약일 때만)
    if (movedTable && merged.status !== "cancelled" && merged.status !== "no-show") {
      const newTableId = `${before.storeId}_${merged.tableNumber}`;
      const t = tablesRef.current.find((x) => x.id === newTableId);
      const cur = t?.status;
      if (!cur || cur === "available" || cur === "setup" || cur === "reserved") {
        await updateFirestoreDoc("tables", newTableId, { status: "reserved" });
      }
    }
  }, [_refreshReservedForTable]);

  const deleteReservation = useCallback(async (id: string) => {
    const before = reservationsRef.current.find((r) => r.id === id);
    await updateFirestoreDoc("reservations", id, undefined, true);
    if (before) {
      await _refreshReservedForTable(before.storeId, before.tableNumber, id);
    }
  }, [_refreshReservedForTable]);

  // ============ PHOTOS ============
  const addPhoto = useCallback(async (input: Omit<Photo, "id" | "createdAt">): Promise<Photo> => {
    const p: Photo = {
      id: generateId(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    await updateFirestoreDoc("photos", p.id, p);
    return p;
  }, []);

  const updatePhoto = useCallback(async (id: string, data: Partial<Photo>) => {
    await updateFirestoreDoc("photos", id, data);
  }, []);

  const deletePhoto = useCallback(async (id: string) => {
    await updateFirestoreDoc("photos", id, undefined, true);
  }, []);

  // ============ STAFF MEMBERSHIP & SHIFTS ============
  const requestJoinStore = useCallback(
    async (storeId: string, position?: string) => {
      const cu = currentUserRef.current;
      if (!cu || cu.role !== "staff") return;
      const patch: Partial<User> = {
        employerStoreId: storeId,
        employerStatus: "pending",
        joinRequestedAt: new Date().toISOString(),
      };
      if (position !== undefined) patch.position = position;
      await updateFirestoreDoc("users", cu.id, patch);
      setCurrentUser({ ...cu, ...patch });
      // 사장님 디바이스 푸시 — 새 직원 가입 요청
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      const staffName = cu.name ?? t("gnotif.staffJoin.nameFallback", ownerLang);
      const positionStr = position ? ` (${position})` : "";
      sendOwnerPush({
        storeId,
        kind: "staff-join",
        title: t("gnotif.staffJoin.title", ownerLang),
        body: t("gnotif.staffJoin.body", ownerLang, { name: staffName, position: positionStr }),
        focusUrl: "/biz/owner/staff",
        tag: "gyeol-staff",
      });
      showToast(t("store.staff.joinRequested"), "success");
    },
    [setCurrentUser]
  );

  const cancelJoinRequest = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff") return;
    // null로 저장해 필드를 명시적으로 비웁니다 (stripUndefined가 undefined를 제거하므로)
    await updateFirestoreDoc("users", cu.id, {
      employerStoreId: null,
      employerStatus: null,
      joinRequestedAt: null,
    });
    setCurrentUser({
      ...cu,
      employerStoreId: undefined,
      employerStatus: undefined,
      joinRequestedAt: undefined,
    });
    showToast(t("store.staff.joinCancelled"), "info");
  }, [setCurrentUser]);

  const approveStaff = useCallback(async (staffId: string) => {
    await updateFirestoreDoc("users", staffId, { employerStatus: "approved" });
    showToast(t("store.staff.approved"), "success");
  }, []);

  const rejectStaff = useCallback(async (staffId: string) => {
    await updateFirestoreDoc("users", staffId, {
      employerStatus: "rejected",
    });
    showToast(t("store.staff.rejected"), "info");
  }, []);

  const removeStaffMembership = useCallback(async (staffId: string) => {
    await updateFirestoreDoc("users", staffId, {
      employerStoreId: null,
      employerStatus: null,
      position: null,
    });
    showToast(t("store.staff.removed"), "info");
  }, []);

  const clockIn = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff" || !cu.employerStoreId || cu.employerStatus !== "approved") {
      showToast(t("store.staff.cannotClockIn"), "error");
      return;
    }
    if (clockingRef.current) return; // 진행 중이면 무시 (연타 방어)
    // 이미 진행 중인 근무가 있으면 무시
    const open = shifts.find((s) => s.staffId === cu.id && !s.clockOutAt);
    if (open) {
      showToast(t("store.staff.alreadyOn"), "info");
      return;
    }
    clockingRef.current = true;
    try {
      const id = generateId();
      const s: Shift = {
        id,
        staffId: cu.id,
        storeId: cu.employerStoreId,
        clockInAt: new Date().toISOString(),
        clockOutAt: null,
      };
      await updateFirestoreDoc("shifts", id, s);
      showToast(t("store.staff.clockInOk"), "success");
    } finally {
      clockingRef.current = false;
    }
  }, [shifts]);

  const clockOut = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff") return;
    if (clockingRef.current) return; // 진행 중이면 무시 (연타 방어)
    const open = shifts.find((s) => s.staffId === cu.id && !s.clockOutAt);
    if (!open) {
      showToast(t("store.staff.noShift"), "info");
      return;
    }
    clockingRef.current = true;
    try {
      await updateFirestoreDoc("shifts", open.id, {
        clockOutAt: new Date().toISOString(),
      });
      showToast(t("store.staff.clockOutOk"), "success");
    } finally {
      clockingRef.current = false;
    }
  }, [shifts]);

  // 현재 사용자 기준 진행 중 근무
  const activeShift = useMemo(() => {
    if (!currentUser || currentUser.role !== "staff") return null;
    return shifts.find((s) => s.staffId === currentUser.id && !s.clockOutAt) ?? null;
  }, [shifts, currentUser]);

  // 컨텍스트 매장 id (사장님=본인 id, 직원=employerStoreId, 그 외="")
  const effectiveStoreId = useMemo(() => {
    if (!currentUser) return "";
    if (currentUser.role === "owner") return currentUser.id;
    if (currentUser.role === "staff" && currentUser.employerStatus === "approved")
      return currentUser.employerStoreId ?? "";
    return "";
  }, [currentUser]);

  // silence unused warning
  void getCustomerTier;

  const value = useMemo<StoreState>(
    () => ({
      isReady,
      firebaseStatus,
      firebaseError,
      currentUser,
      masterPassword,
      isMaster,
      users,
      visits,
      coupons,
      tables,
      sections,
      communications,
      tierOverrides,
      menus,
      orders,
      reservations,
      photos,
      shifts,
      ingredients,
      expenses,
      marketingDrafts,
      activeShift,
      effectiveStoreId,
      activeStoreId,
      setActiveStoreId,
      login,
      logout,
      deleteAccount,
      setMasterPassword,
      markPhoneVerified,
      loginMaster,
      logoutMaster,
      deleteUser,
      recordVisit,
      leaveTable,
      enterTable,
      evictTable,
      issueCoupon,
      requestCouponUse,
      cancelCouponRequest,
      approveCouponUse,
      rejectCouponUse,
      addTable,
      updateTableLayout,
      deleteTable,
      updateTableStatus,
      initTables,
      addSection,
      updateSection,
      deleteSection,
      addMenuItem,
      updateMenuItem,
      deleteMenuItem,
      placeOrder,
      updateOrderStatus,
      payTableSession,
      approvePayment,
      moveOrdersTable,
      confirmTossPayment,
      completeTable,
      printInterimReceipt,
      recordCommunication,
      updateUserMemo,
      setStaffWage,
      setStaffLevel,
      setStaffPerms,
      setCustomerTier,
      bulkIssueCoupon,
      updateBrandSettings,
      updateStoreConfig,
      updateStoreLocation,
      addReservation,
      updateReservation,
      deleteReservation,
      addPhoto,
      updatePhoto,
      deletePhoto,
      addIngredient,
      updateIngredient,
      deleteIngredient,
      addExpense,
      deleteExpense,
      addMarketingDraft,
      reviewMarketingDraft,
      updateMarketingDraftContent,
      deleteMarketingDraft,
      requestJoinStore,
      cancelJoinRequest,
      approveStaff,
      rejectStaff,
      removeStaffMembership,
      clockIn,
      clockOut,
    }),
    [
      isReady,
      firebaseStatus,
      firebaseError,
      currentUser,
      masterPassword,
      isMaster,
      users,
      visits,
      coupons,
      tables,
      sections,
      communications,
      tierOverrides,
      menus,
      orders,
      reservations,
      photos,
      shifts,
      ingredients,
      expenses,
      marketingDrafts,
      activeShift,
      effectiveStoreId,
      activeStoreId,
      login,
      logout,
      deleteAccount,
      setMasterPassword,
      markPhoneVerified,
      loginMaster,
      logoutMaster,
      deleteUser,
      recordVisit,
      leaveTable,
      enterTable,
      evictTable,
      issueCoupon,
      requestCouponUse,
      cancelCouponRequest,
      approveCouponUse,
      rejectCouponUse,
      addTable,
      updateTableLayout,
      deleteTable,
      updateTableStatus,
      initTables,
      addSection,
      updateSection,
      deleteSection,
      addMenuItem,
      updateMenuItem,
      deleteMenuItem,
      placeOrder,
      updateOrderStatus,
      payTableSession,
      approvePayment,
      moveOrdersTable,
      confirmTossPayment,
      completeTable,
      printInterimReceipt,
      recordCommunication,
      updateUserMemo,
      setStaffWage,
      setStaffLevel,
      setStaffPerms,
      setCustomerTier,
      bulkIssueCoupon,
      updateBrandSettings,
      updateStoreConfig,
      updateStoreLocation,
      addReservation,
      updateReservation,
      deleteReservation,
      addPhoto,
      updatePhoto,
      deletePhoto,
      addIngredient,
      updateIngredient,
      deleteIngredient,
      addExpense,
      deleteExpense,
      addMarketingDraft,
      reviewMarketingDraft,
      updateMarketingDraftContent,
      deleteMarketingDraft,
      requestJoinStore,
      cancelJoinRequest,
      approveStaff,
      rejectStaff,
      removeStaffMembership,
      clockIn,
      clockOut,
    ]
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be inside StoreProvider");
  return ctx;
}

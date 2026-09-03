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

export type DbStatus = "connecting" | "ok" | "error" | "offline";

export interface StoreState {
  isReady: boolean;
  dbStatus: DbStatus;
  dbError: string | null;
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

export interface LoginInput {
  /**
   * OTP 검증으로 만들어진 auth 사용자 id.
   * 없으면 login() 이 거부한다 — 이게 없으면 예전의 무비밀번호 로그인이 되살아난다.
   */
  authUserId?: string;
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

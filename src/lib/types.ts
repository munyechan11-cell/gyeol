export type Role = "customer" | "owner" | "staff";
/** 직원 권한 등급 — 1 알바생 · 2 정규직 · 3 매니저 · 4 실장. 높을수록 하위 등급 권한이 모두 누적된다. */
export type StaffLevel = 1 | 2 | 3 | 4;
export type StaffStatus = "pending" | "approved" | "rejected";
export type AuthType = "phone" | "google" | "kakao" | "naver";
export type Industry = "cafe" | "meat" | "bakery" | "general";
export type RewardType = "point" | "stamp";
export type Tier = "일반" | "브론즈" | "실버" | "골드" | "다이아" | "VIP";

export interface StoreConfig {
  industry: Industry;
  rewardType: RewardType;
  pointRate?: number;
  stampMax?: number;
  marketingTriggers?: { inactiveDays?: number; birthdayCoupon?: boolean };
  /** 리뷰 작성 보상 쿠폰(8-5) — 켜면 손님이 결제 시 리뷰(별점/글)를 남기면 자동으로 쿠폰 지급. */
  reviewCoupon?: { enabled?: boolean; amount?: number; description?: string };
  smsApiKey?: string;
  alimtalkSenderId?: string;
  defaultDashboardView?: "grid" | "map";
  crmCustomInsights?: Record<string, string>;
  locationAccessOnly?: boolean;
  allowedRadius?: number;
  tossClientKey?: string;
  /** 키오스크 모드 사용 — 사장님이 켜면 NAV에 키오스크 메뉴가 노출됨 */
  kioskEnabled?: boolean;
  /** 재고/원가 관리 모드 — full(깐깐 ERP·기본)·simple(간편 입력)·ai(AI 자동 원가율) */
  inventoryMode?: "full" | "simple" | "ai";
  /** 매장 색 테마 id (src/lib/themes.ts). 미설정 시 업종 기본 테마로 폴백 */
  theme?: string;
  /** 가게 공개 사이트 글꼴 프리셋 id (src/lib/siteFonts.ts, TODO 8-1). 미설정 시 editorial. */
  fontTheme?: string;
  /** 사이트 부제/한줄 소개 (예: "눈꽃빙수·수플레"). 공개 사이트 Hero·헤더에 표시. */
  tagline?: string;
  /** 매장 주소 (공개 사이트 '찾아오시는 길'에 표시·지도 링크). */
  address?: string;
  /** AI 전화 예약 설정 — 가게마다 전화번호·인사말이 다르므로 매장별 설정. 서버 예약 두뇌(server.ts)가 참조. */
  aiReservation?: {
    /** 이 매장에서 AI 전화 예약을 켰는지 */
    enabled?: boolean;
    /** 이 매장으로 걸려오는(또는 착신전환되는) 대표 전화번호 — 음성채널이 number→storeId 매핑에 사용 */
    phoneNumber?: string;
    /** AI 첫 인사말 (미설정 시 기본 문구). 예: "안녕하세요, OO식당입니다. 예약 도와드릴까요?" */
    greeting?: string;
    /** 한 예약이 테이블을 점유하는 시간(분). 미설정 시 90 */
    durationMin?: number;
  };
  /** 마케팅 자율 에이전트("사장님 비서") 프로필 (TODO 7-1). 콘텐츠 생성·응대 초안의 톤·타깃 기준. */
  marketingAgent?: {
    enabled?: boolean;
    /** 말투/톤 (예: "친근하고 따뜻하게", "정중하게") */
    tone?: string;
    /** 타깃 고객 (예: "20-30대 직장인", "가족 단위") */
    target?: string;
    /** 강조 키워드 (쉼표 구분) */
    keywords?: string;
    /** 금지어 (쉼표 구분) — 콘텐츠에 절대 넣지 않을 표현 */
    bannedWords?: string;
    /** 자동 발행 여부 — 책임이 크므로 기본 false(사람 승인 필수). 골격 단계에선 항상 false. */
    autoPublish?: boolean;
    /** 하루 발행 한도 (가드레일 7-7). 0/미설정 = 무제한. 최근 24시간 발행 수가 이 값 이상이면 발행 차단. */
    dailyPublishLimit?: number;
  };
  /** 외부 채널 발행 설정 (TODO 7-4) — Zernio 등 소셜 발행 대행 계정 매핑. 가게마다 자기 계정. */
  publishing?: {
    /** 이 매장 전용 Zernio 프로필 id — 사장님이 자기 소셜을 이 프로필에 OAuth 연결. */
    zernioProfileId?: string;
    /** 연결된 채널들 — platform 키('instagram'|'googlebusiness') → { accountId, username }. */
    channels?: Record<string, { accountId: string; username?: string }>;
    /** (구) 단일 인스타 필드 — 호환용. 신규는 channels 사용. */
    instagramAccountId?: string;
    instagramUsername?: string;
  };
  /** 결 요금제 — free(채널 1개) / pro(채널 여러 개, 월 ₩10,000). 미설정=free. */
  plan?: "free" | "pro";
}

export interface User {
  id: string;
  role: Role;
  name: string;
  phone: string;
  restaurantName?: string;
  storeId?: string;
  googleId?: string;
  kakaoId?: string;
  socialIds?: string[];
  authType?: AuthType;
  status?: "active" | "deleted";
  /** 전화번호 SMS 인증을 통과한 시각. 미설정 = 미인증 → 로그인 시 강제 인증 모달. */
  phoneVerifiedAt?: string;
  linkedProviders?: ("google" | "kakao" | "naver")[];
  isPohangResident?: boolean;
  gender?: "male" | "female";
  memo?: string;
  tierNames?: Record<string, string>;
  tierRewards?: Record<string, string>;
  avatarUrl?: string;
  aligoKey?: string;
  aligoUserId?: string;
  aligoSender?: string;
  smsGatewayUrl?: string;
  foodtechStoreCode?: string;
  /** 사용 중인 POS 벤더 */
  posVendor?: string;
  /** POS API Key 또는 매장 코드 (벤더별로 의미 다름). 비어 있으면 영수증 인쇄 폴백 */
  posApiKey?: string;
  /** 토스플레이스(오프라인 토스 POS) 매출 연동 — 비밀 키는 store_secrets(서버 전용)에 저장하고
   *  여기엔 비밀 아닌 표시용 정보만 둔다. */
  tossPlace?: { merchantId?: string; connectedAt?: string };
  /** 영수증 인쇄 브릿지 사용 의도 (사장님 토글). PC 트레이 앱이 페어링되면 자동으로 큐 발행 */
  printBridgeEnabled?: boolean;
  /** 매장 영업 시간 — 요일별 (다음 turn 에 풀 구현 예정). 미설정 시 항상 영업 중으로 간주 */
  businessHours?: BusinessHours;
  /** 임시 마감(긴급 휴무) — 사장님 헤더 토글로 즉시 ON/OFF */
  temporarilyClosed?: boolean;
  /** 임시 마감 사유 (선택) */
  temporaryClosedReason?: string;
  /** FCM 디바이스 토큰 목록 — 사장님 폰/PC 여러 대 가능. 다중 발송용 */
  fcmTokens?: Array<{ token: string; platform?: string; registeredAt: string }>;
  /** 푸시 알림 종류별 ON/OFF — 사장님이 BrandSettings 에서 조정 */
  pushPrefs?: {
    newOrder?: boolean;       // 새 주문 도착
    paymentRequest?: boolean; // 결제 요청
    staffJoin?: boolean;      // 직원 가입 요청
    couponRequest?: boolean;  // 쿠폰 사용 요청
  };
  /** 사장님 앱 언어 — 받는 푸시·알림을 이 언어로 보냄. (i18n Lang 과 동일 집합) */
  lang?: "ko" | "en" | "vi" | "zh";
  /** 페어링된 에이전트 식별자 (디바이스명·OS·페어링 시각). 페어링 해제 시 비움 */
  printBridgeDevice?: { name?: string; pairedAt: string };
  /** 에이전트 마지막 하트비트 시각 — 60초 이상 지나면 '오프라인'으로 표시 */
  printBridgeHeartbeatAt?: string;
  storeConfig?: StoreConfig;
  rewardBalance?: number;
  lat?: number;
  lng?: number;
  birthYear?: number;
  birthday?: string;
  ageGroup?: string;
  privacyAgreedAt?: string;
  /** 직원 전용: 소속 매장 owner id */
  employerStoreId?: string;
  /** 직원 전용: 소속 매장 승인 상태 */
  employerStatus?: StaffStatus;
  /** 직원 전용: 직책/포지션 (홀, 주방 등) */
  position?: string;
  /** 직원 전용: 권한 등급 1=알바 2=정규직 3=매니저 4=실장. 미설정=1(알바). 사장님이 직원관리에서 지정. */
  staffLevel?: StaffLevel;
  /** 직원 전용: 등급 기본 권한을 넘어 사장님이 개별 허용한 경로 목록 (예: 정규직이지만 정산만 추가 허용). */
  extraPerms?: string[];
  /** 직원 전용: 시급 (KRW) — 급여 계산용. 사장님이 설정. */
  hourlyWage?: number;
  /** 직원 전용: 가입 요청 시각 */
  joinRequestedAt?: string;
}

export interface Shift {
  id: string;
  staffId: string;
  storeId: string;
  clockInAt: string;
  clockOutAt?: string | null;
}

export interface Visit {
  id: string;
  customerId: string;
  storeId: string;
  date: string;
  tableNumber: number;
  totalAmount?: number;
}

export type CouponStatus = "available" | "pending" | "used";
export interface Coupon {
  id: string;
  customerId: string;
  storeId: string;
  type: string;
  description: string;
  /** 등급 자동 쿠폰의 i18n 키 — 있으면 표시 시 고객 언어로 변환. 사장님 커스텀 보상은 미설정(description 사용). */
  descKey?: string;
  /** 금액 쿠폰이면 할인액(원). >0 이면 사용 승인 시 그 테이블 계산서에서 자동 차감(8-7). 없으면 일반 쿠폰(수동). */
  amount?: number;
  status: CouponStatus;
  issuedAt: string;
  usedAt?: string;
  usedAtTable?: number;
}

/**
 * 테이블 8단계 워크플로우 (2026-06).
 *
 * 자동 = 시스템이 트리거 (loadOrders, enterTable, approvePayment 등)
 * 수동 = 사장님/직원이 모달에서 버튼 클릭
 *
 *  1. available  비어있음    자동 (초기/청소완료 시 복귀)
 *  2. reserved   예약됨      수동 (사장님이 예약 입력 또는 직접 표시)
 *  3. setup      세팅완료    수동 (사장님 "준비됐어요" → 손님 입장 대기)
 *  4. occupied   손님입장    자동 (QR enterTable)
 *  5. dining     식사중      자동 (첫 주문 발생 시)
 *  6. paid       결제완료    자동 (approvePayment)
 *  7. cleaning   청소·정리중 수동 (사장님 "정리 시작")
 *  8. → available 청소완료    수동 (사장님 "정리 완료") → 비어있음 자동 복귀
 *
 * 'dirty' 는 호환을 위한 alias → cleaning 으로 매핑.
 */
/**
 * 매장 영업 시간 — 요일별 + 휴게시간 + 휴무일.
 * day 인덱스: 0=일, 1=월, ..., 6=토.
 */
export interface BusinessHours {
  /** 요일별 영업 시간. 각 요일은 ranges 0개 = 휴무, 1개 이상 = 영업 (휴게시간 분리 시 ranges 가 2개) */
  weekly?: Array<{
    open?: string;  // "HH:MM" (예: "09:00")
    close?: string; // "HH:MM" (예: "22:00")
    closed?: boolean; // true 면 그 요일 휴무
    breakStart?: string;
    breakEnd?: string;
  }>;
  /** 특정 날짜 휴무 (YYYY-MM-DD 목록) — 명절·임시휴무 등 */
  closedDates?: string[];
  /** 24시 영업 여부 (true 면 weekly 무시) */
  open24h?: boolean;
}

export type TableStatus =
  | "available"
  | "reserved"
  | "setup"
  | "occupied"
  | "dining"
  | "paid"
  | "cleaning"
  | "dirty";  // legacy alias for cleaning
export interface TableDoc {
  id: string;
  number: number;
  storeId: string;
  currentCustomerId?: string | null;
  /** 함께 앉은 손님 customerId 들 (currentCustomerId 포함). 합석·인원 수 표시용 */
  occupantIds?: string[];
  /** 캐시된 대표 손님 이름 — 사장님 화면에서 빠르게 표시 */
  currentCustomerName?: string | null;
  /** 인원수 (사장님이 입력 또는 손님이 진입 시 선언). 미정이면 null */
  partySize?: number | null;
  sessionStartTime?: string | null;
  x: number;
  y: number;
  width?: number;
  height?: number;
  seats: number;
  isRoom?: boolean;
  type?: "table" | "room" | "corridor" | "pos" | "door";
  shape?: "square" | "circle";
  sectionId?: string;
  status?: TableStatus;
}

export interface Section {
  id: string;
  storeId: string;
  name: string;
  order: number;
}

export interface Communication {
  id: string;
  customerId: string;
  storeId: string;
  type: "coupon" | "message";
  senderRole?: "owner" | "customer";
  content: string;
  date: string;
}

export interface TierOverride {
  customerId: string;
  storeId: string;
  tier: Tier | "auto";
}

/** 메뉴 옵션 1개 (모디파이어) — 예: "아이스", "곱빼기" */
export interface MenuOption {
  id: string;          // 그룹 내 고유 (예: "ice")
  name: string;        // 표시 라벨 (예: "아이스")
  priceDelta: number;  // 기본가 대비 가감액(KRW). 0=무료, 음수=할인 허용
  /** 이 옵션 선택 시 추가로 차감되는 원재료(예: 곱빼기 = 면 +1). 미설정 시 재고 영향 없음 */
  recipe?: { ingredientId: string; quantity: number }[];
}
/** 옵션 그룹 — 예: "온도"(아이스/핫), "양"(보통/곱빼기 +1000) */
export interface OptionGroup {
  id: string;           // 메뉴 내 고유 (예: "temp")
  name: string;         // 그룹명 (예: "온도")
  required: boolean;    // 필수 선택 여부 (단일=정확히 1, 복수=최소 1)
  multiSelect: boolean; // false=정확히 1개(라디오), true=0..N(체크박스)
  options: MenuOption[];
}

export interface Menu {
  id: string;
  storeId: string;
  name: string;
  price: number;
  category: string;
  imageUrl?: string;
  description?: string;
  isAvailable?: boolean;
  posProductCode?: string;
  /** 메뉴 1인분에 소요되는 원재료 목록 — 판매 시 자동 차감 + 원가 계산 */
  recipe?: { ingredientId: string; quantity: number }[];
  /** 옵션 그룹(모디파이어) — 미설정 시 옵션 없는 기존 메뉴와 동일 동작 */
  optionGroups?: OptionGroup[];
}

/** 원재료 — 매장에 보관하는 식자재/물품. */
export interface Ingredient {
  id: string;
  storeId: string;
  /** 표시 이름 (예: "쌀", "양배추", "맥주 500ml") */
  name: string;
  /** 단위 (예: "kg", "g", "L", "ml", "개") */
  unit: string;
  /** 현재 재고 수량 (단위: unit) */
  stock: number;
  /** 단위당 원가 — 메뉴 원가 계산에 사용 (KRW) */
  unitCost: number;
  /** 부족 알림 임계값. 미설정 시 알림 없음 */
  lowThreshold?: number;
  /** 마지막 수동 조정/입고 시각 */
  updatedAt: string;
  /** 메모 — 거래처 등 자유 입력 */
  memo?: string;
}

/** 지출/비용 — 매출장부 순이익 계산용. 사장님이 직접 입력. */
export type ExpenseCategory = "rent" | "labor" | "material" | "utility" | "marketing" | "other";
export interface Expense {
  id: string;
  storeId: string;
  category: ExpenseCategory;
  /** 금액 (KRW) */
  amount: number;
  /** 지출일 YYYY-MM-DD (로컬) */
  date: string;
  memo?: string;
  createdAt: string;
}

export type OrderStatus = "pending" | "accepted" | "cooking" | "served" | "cancelled";
/** 주문 항목에 선택된 옵션 — 라벨을 비정규화 저장(나중에 옵션명이 바뀌어도 과거 영수증/주방표는 그대로) */
export interface SelectedOption {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  priceDelta: number;
}
export interface OrderItem {
  menuId: string;
  name: string;
  quantity: number;
  price: number; // 단가 = 기본가 + Σ(선택옵션 priceDelta). 옵션 반영 단가라 모든 합계·표시 로직 그대로 동작
  /** 선택된 옵션들 — 옵션 없는 항목엔 없음(하위호환) */
  selectedOptions?: SelectedOption[];
}
export interface Order {
  id: string;
  storeId: string;
  tableNumber: number;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  paymentStatus?: "unpaid" | "requested" | "paid" | "refunded";
  /** 결제수단 — 카드(토스)/현금(수동승인). 매출장부 분리용. */
  paymentMethod?: "card" | "cash";
  /** 주문 출처 — app(앱 주문·기본) / tossplace(오프라인 토스 POS 웹훅 유입). 매출엔 함께 잡히되 주방·테이블 흐름에선 제외. */
  source?: "app" | "tossplace";
  createdAt: string;
}

export type ReservationStatus = "confirmed" | "cancelled" | "completed" | "no-show";
export interface Reservation {
  id: string;
  storeId: string;
  date: string;
  time: string;
  tableNumber: number;
  partySize: number;
  customerName: string;
  customerPhone: string;
  memo?: string;
  status: ReservationStatus;
  createdAt: string;
}

export interface Photo {
  id: string;
  storeId: string;
  /** "review": 손님이 결제 시 남긴 리뷰(글/별점, 사진은 선택). "menu"/"customer": 매장 운영용 사진. */
  type: "menu" | "customer" | "review";
  /** 리뷰는 사진 없어도 됨 — 글/별점만으로 저장 가능. */
  imageData?: string;
  orderId?: string;
  tableNumber?: number;
  customerId?: string;
  customerName?: string;
  menuName?: string;
  snsConsent?: boolean;
  consentedAt?: string;
  pairedPhotoId?: string;
  /** 리뷰 별점 1~5 (선택). */
  rating?: number;
  /** 리뷰 본문 (선택). */
  reviewText?: string;
  /** 사장님 답글 — 손님 리뷰에 대한 응답. 한 리뷰당 1개만. */
  ownerReply?: {
    text: string;
    repliedAt: string;
  };
  /** 외부 채널 자동 업로드 상태 — 추후 블로그/구글 리뷰 연동 대비. */
  syncedTo?: {
    google?: { id?: string; syncedAt: string };
    blog?: { id?: string; syncedAt: string };
  };
  createdAt: string;
}

// ============================================================
// 마케팅 자율 에이전트 ("사장님 비서") — TODO 7
// 에이전트가 만든 콘텐츠/응대는 항상 '초안(draft)'으로 들어와 사장 승인 후에만 발행된다.
// 모든 상태 전이는 audit 로 남긴다(자동 발행은 책임이 크므로 승인 게이트·로깅 필수).
// ============================================================
export type MarketingDraftStatus = "draft" | "approved" | "rejected" | "published";
export interface MarketingDraftLog {
  /** ISO 시각 */
  at: string;
  /** created | edited | approved | rejected | published */
  action: string;
  /** 행위자 (owner id 등) */
  by?: string;
  /** 비고 (거절 사유 등) */
  note?: string;
}
export interface MarketingDraft {
  id: string;
  storeId: string;
  /** 발행 대상 채널 */
  channel: "instagram" | "naverPlace" | "general";
  /** 게시물 초안 vs 리뷰/DM 응대 초안 */
  kind: "post" | "reply";
  title?: string;
  content: string;
  status: MarketingDraftStatus;
  /** 생성 출처 — 에이전트 생성 vs 사람 수동 */
  source: "agent" | "manual";
  /** 응대(reply) 초안이 답할 대상 — 리뷰(photos) id. 발행 시 그 리뷰의 ownerReply 로 기록. */
  targetId?: string;
  /** 대상 요약 — 큐에서 원본 리뷰를 함께 보여주기 위한 스냅샷(예: 별점·리뷰 글 일부) */
  targetSummary?: string;
  createdAt: string;
  reviewedAt?: string;
  publishedAt?: string;
  /** 감사 로그 — 생성·수정·승인·거절·발행 전체 기록 */
  audit: MarketingDraftLog[];
}

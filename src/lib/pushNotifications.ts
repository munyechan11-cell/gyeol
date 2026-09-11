/**
 * 결(Gyeol) 푸시 알림 — 클라이언트.
 *
 * 흐름:
 *  1. ensureMessagingReady() — 브라우저 지원 + 권한 + 서비스 워커 준비
 *  2. registerOwnerDevice() — FCM 토큰 발급 → 내 users 행의 fcmTokens 에 등록
 *  3. unregisterOwnerDevice(userId) — 현재 디바이스 토큰 제거
 *  4. listenForeground() — 앱이 열려있을 때 도착하는 알림 처리 (toast)
 *
 * 호환:
 *  - 데스크탑 Chrome/Edge/Firefox: ✅ 풀 지원
 *  - iOS Safari 16.4+: ⚠️ 홈 화면에 추가된 PWA 에서만 작동
 *  - 그 외: 자동으로 비활성, isPushSupported() 가 false 반환
 */
import { getMessaging, getToken, onMessage, isSupported, type Messaging } from "firebase/messaging";
import { app } from "./firebase";
import { supabase } from "./supabase";
import { showToast } from "./toast";

// Firebase Console → Project Settings → Cloud Messaging → Web Push certificates 에서 생성한 키.
// 환경변수가 있으면 그걸 우선 (운영 키 분리 가능).
const VAPID_KEY_ENV = ((import.meta as any).env?.VITE_FCM_VAPID_KEY as string | undefined)?.trim();
// 빈 값·placeholder 감지 — 잘못된 키로 호출하지 않도록.
const VAPID_KEY = VAPID_KEY_ENV || "";
const isVapidConfigured = (): boolean => {
  // VAPID public key 는 보통 'B' 로 시작하는 88자 base64url. 70자 이상이면 일단 시도.
  return !!VAPID_KEY && VAPID_KEY.length >= 70;
};

let messagingInstance: Messaging | null = null;
let supportedCache: boolean | null = null;

export async function isPushSupported(): Promise<boolean> {
  if (supportedCache !== null) return supportedCache;
  try {
    supportedCache = await isSupported();
  } catch {
    supportedCache = false;
  }
  return supportedCache;
}

async function getMessagingSafe(): Promise<Messaging | null> {
  if (messagingInstance) return messagingInstance;
  if (!app) return null;
  const ok = await isPushSupported();
  if (!ok) return null;
  try {
    messagingInstance = getMessaging(app);
    return messagingInstance;
  } catch (e: any) {
    console.warn("[push] getMessaging failed", e?.message);
    return null;
  }
}

/** 알림 권한 상태 — 'default' | 'granted' | 'denied' | 'unsupported' */
export type PermissionState = "default" | "granted" | "denied" | "unsupported";
export async function getPermissionState(): Promise<PermissionState> {
  if (!(await isPushSupported())) return "unsupported";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as PermissionState;
}

/** 등록 실패 reason — UI 에서 친화적 메시지로 변환 */
export type RegisterReason =
  | "unsupported"
  | "denied"
  | "no-vapid"
  | "sw-register-failed"
  | "no-db"
  | "no-auth"
  | "firestore-error"
  | "error";

/**
 * 사장님 디바이스를 푸시 대상으로 등록.
 * - 권한이 default 면 요청 다이얼로그
 * - 권한 OK 면 FCM 토큰 발급 → 내 users 행의 fcmTokens 배열에 등록
 * - 동일 토큰은 dedup
 */
export async function registerOwnerDevice(userId: string): Promise<{
  ok: boolean;
  reason?: RegisterReason;
  detail?: string;
  token?: string;
}> {
  if (!userId) return { ok: false, reason: "error", detail: "userId 없음" };

  // VAPID 키 검증 — placeholder 면 즉시 차단 (잘못된 키로 Firebase 호출 시 invalid 에러 + 토큰 발급 거부)
  if (!isVapidConfigured()) {
    return {
      ok: false,
      reason: "no-vapid",
      detail: "VAPID 공개 키가 설정되지 않았어요. (VITE_FCM_VAPID_KEY)",
    };
  }

  const messaging = await getMessagingSafe();
  if (!messaging) return { ok: false, reason: "unsupported" };

  // 로그인 세션 확인 — 토큰은 "내 계정"에만 붙는다. 세션이 없으면 붙일 곳이 없다.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    return { ok: false, reason: "no-auth", detail: "로그인이 필요해요." };
  }

  // 권한 요청 (다이얼로그)
  let perm: NotificationPermission;
  try {
    perm = await Notification.requestPermission();
  } catch (e: any) {
    return { ok: false, reason: "denied", detail: e?.message };
  }
  if (perm !== "granted") return { ok: false, reason: "denied" };

  // 서비스 워커 등록 — Firebase 가 자동으로도 등록하지만 명시 등록이 더 안정적
  let swReg: ServiceWorkerRegistration | undefined;
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", {
        scope: "/firebase-cloud-messaging-push-scope",
      });
      // 활성화 대기 (최대 3초)
      if (swReg.installing) {
        await new Promise<void>((resolve) => {
          const inst = swReg!.installing!;
          // resolve 시점·타임아웃 양쪽에서 리스너를 제거 — 안 그러면 activated 가
          // 안 올 때 statechange 리스너가 영구히 남아 권한 재시도마다 누적됨.
          const finish = () => {
            clearTimeout(timer);
            inst.removeEventListener("statechange", onChange);
            resolve();
          };
          const onChange = () => { if (inst.state === "activated") finish(); };
          const timer = setTimeout(finish, 3000);
          inst.addEventListener("statechange", onChange);
        });
      }
    } catch (e: any) {
      console.error("[push] SW register failed", e);
      return { ok: false, reason: "sw-register-failed", detail: e?.message };
    }
  } else {
    return { ok: false, reason: "sw-register-failed", detail: "Service Worker 미지원 브라우저" };
  }

  // 토큰 발급
  let token: string | undefined;
  try {
    token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swReg,
    });
  } catch (e: any) {
    const code = e?.code ?? "";
    const msg = e?.message ?? String(e);
    console.error("[push] getToken failed", code, msg);
    // Firebase 에러 코드별 분류
    if (code.includes("messaging/permission-blocked") || code.includes("permission")) {
      return { ok: false, reason: "denied", detail: msg };
    }
    if (code.includes("messaging/invalid-vapid-key") || msg.toLowerCase().includes("vapid")) {
      return { ok: false, reason: "no-vapid", detail: msg };
    }
    if (code.includes("messaging/failed-service-worker-registration") || code.includes("service-worker")) {
      return { ok: false, reason: "sw-register-failed", detail: msg };
    }
    return { ok: false, reason: "error", detail: `${code} ${msg}` };
  }
  if (!token) return { ok: false, reason: "error", detail: "토큰 발급 결과가 비어있음" };

  // 등록은 DB 함수가 한다. 단순 배열 추가로 보이지만 아니다 — entry 에 매번
  // 달라지는 registeredAt 이 들어 있어 값 비교로는 같은 토큰을 못 알아본다.
  // 예전엔 그래서 같은 기기가 등록할 때마다 entry 가 쌓이고, 죽은 토큰으로
  // FCM 을 두들겼다. "같은 token 은 하나만" 을 지키려면 읽고-거르고-쓰기를
  // 한 번에 해야 하고, 그건 SQL 안에서만 원자적이다.
  // 대상은 항상 자기 자신이다(auth.uid()) — userId 를 보내지 않는다.
  try {
    const { error } = await supabase.rpc("set_fcm_token", {
      p_token: token,
      p_platform: navigator.platform || "web",
    });
    if (error) throw error;
  } catch (e: any) {
    console.error("[push] 토큰 등록 실패", e?.code, e?.message);
    return { ok: false, reason: "firestore-error", detail: e?.message, token };
  }

  return { ok: true, token };
}

/**
 * 현재 디바이스 토큰을 내 계정에서 제거 — 호출 시 토큰 발급은 시도하지 않음.
 *
 * 등록과 같은 이유로 DB 함수를 쓴다. entry 가 객체라 "그 token 을 가진 것"을
 * 골라내야 하는데, 값 전체 일치로는 registeredAt 때문에 못 맞춘다.
 */
export async function unregisterOwnerDevice(userId: string): Promise<void> {
  void userId; // 대상은 항상 세션의 주인이다.
  const messaging = await getMessagingSafe();
  if (!messaging || !isVapidConfigured()) return;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY }).catch(() => undefined);
    if (!token) return;
    const { error } = await supabase.rpc("remove_fcm_token", { p_token: token });
    if (error) throw error;
  } catch (e: any) {
    console.warn("[push] unregister failed", e?.message);
  }
}

/** 앱이 포커스 상태일 때 도착하는 메시지를 toast 로 전환. App.tsx 부팅 시 한 번 호출. */
let foregroundListenerSetup = false;
export async function listenForeground() {
  if (foregroundListenerSetup) return;
  const messaging = await getMessagingSafe();
  if (!messaging) return;
  onMessage(messaging, (payload) => {
    const title = payload.notification?.title ?? payload.data?.title ?? "결 알림";
    const body = payload.notification?.body ?? payload.data?.body ?? "";
    showToast(`${title} — ${body}`.slice(0, 140), "info");
  });
  foregroundListenerSetup = true;
}

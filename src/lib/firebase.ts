import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";

import firebaseConfigFromJson from "../../firebase-applet-config.json";

/**
 * Firebase — **이제 웹 푸시(FCM)만 쓴다.**
 *
 * 데이터는 전부 Supabase 로 옮겼다(src/lib/db.ts, src/lib/realtime.ts).
 * 로그인도 Supabase Auth 다(src/lib/phoneVerify.ts, src/lib/auth.ts).
 * 여기 남은 건 알림 하나뿐이다.
 *
 * 왜 이것만 남겼나 — FCM 은 Firestore 와 별개 제품이고 무료다. 그리고 웹 푸시
 * 구독은 브라우저가 특정 발신자(VAPID 키)에 묶어 발급하므로, 공급자를 바꾸면
 * **모든 사장님이 알림을 다시 허용해야 한다.** 얻는 것 없이 그걸 요구할 이유가 없다.
 *
 * 그래서 이 파일은 앱 핸들 하나만 내보낸다. 예전에는 Firestore 핸들·익명 로그인·
 * 컬렉션 목록까지 여기 있었는데, 남겨 두면 "아직 Firestore 를 쓰는구나" 하고
 * 새 코드가 그리로 붙는다.
 */

const env = (import.meta as any).env ?? {};

const firebaseConfig = {
  ...firebaseConfigFromJson,
  apiKey: env.VITE_FIREBASE_API_KEY || (firebaseConfigFromJson as any).apiKey,
  projectId: env.VITE_FIREBASE_PROJECT_ID || (firebaseConfigFromJson as any).projectId,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || (firebaseConfigFromJson as any).authDomain,
};

/** 설정이 비어 있거나 자리표시자면 초기화하지 않는다 — 푸시만 조용히 꺼진다. */
export const isFirebaseConfigured =
  !!firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== "YOUR_API_KEY" &&
  firebaseConfig.apiKey !== "undefined";

export const app: FirebaseApp | null = isFirebaseConfigured
  ? getApps().length > 0
    ? getApp()
    : initializeApp(firebaseConfig)
  : null;

import { api } from "./api";
import { t } from "./i18n";
import { supabase } from "./supabase";

/**
 * 소셜 로그인 — 세션까지 만들어 준다.
 *
 * **예전 구조의 문제.** 소셜 버튼은 공급자에게서 프로필만 받아 왔고, 그 프로필을
 * 그대로 login() 에 넘겼다. 로그인에 필요한 건 그게 전부였다 — 즉 "카카오 id 가
 * 무엇인지 아는 사람"이면 누구든 들어올 수 있었다는 뜻이다.
 *
 * 이제 두 함수 모두 **끝나는 시점에 Supabase 세션이 존재**한다. login() 은 세션에서
 * 신원을 읽으므로, 세션 없이는 어떤 경로로도 로그인이 되지 않는다.
 *
 *   · 구글  — Supabase OAuth 리다이렉트. 세션이 곧바로 생긴다.
 *   · 카카오 — 카카오 JS SDK 로 받은 액세스 토큰을 서버로 보내고, 서버가 카카오에
 *             직접 확인한 뒤 1회용 토큰을 준다. 그걸 세션으로 교환한다.
 *             (SDK 를 유지하는 이유는 국내 앱 사용자에게 카카오톡 연동 UX 가 낫기 때문이다.)
 */

export interface SocialResult {
  /** 공급자가 부여한 id. users 문서의 kakaoId·googleId·socialIds 에 그대로 들어간다. */
  provider: "google" | "kakao";
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

const GOOGLE_REDIRECT_FLAG = "gyeol:pending-google-redirect";

/**
 * 구글 로그인. 리다이렉트 방식이라 이 함수는 **정상 경로에서 반환하지 않는다** —
 * 페이지가 구글로 넘어가고, 돌아온 뒤 consumeGoogleRedirect() 가 결과를 줍는다.
 *
 * 팝업을 쓰지 않는 이유: 카톡·인스타 인앱 브라우저에서 팝업이 조용히 막히거나
 * 화면 밖에서 열려, 사용자는 아무 일도 안 일어난 것처럼 느낀다. 리다이렉트는
 * 모든 환경에서 같게 동작한다.
 */
export async function signInWithGoogle(): Promise<SocialResult> {
  sessionStorage.setItem(GOOGLE_REDIRECT_FLAG, "1");
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.href },
  });
  if (error) {
    sessionStorage.removeItem(GOOGLE_REDIRECT_FLAG);
    throw error;
  }
  throw new Error("REDIRECT_IN_PROGRESS");
}

/**
 * 리다이렉트로 돌아온 뒤 세션을 회수한다. 처리할 게 없으면 null.
 * (URL 의 인증 파라미터는 supabase 클라이언트가 detectSessionInUrl 로 이미 소비했다.)
 */
export async function consumeGoogleRedirect(): Promise<SocialResult | null> {
  const flag = sessionStorage.getItem(GOOGLE_REDIRECT_FLAG);
  if (!flag) return null;
  sessionStorage.removeItem(GOOGLE_REDIRECT_FLAG);
  const { data } = await supabase.auth.getSession();
  const u = data.session?.user;
  if (!u) return null;
  const meta = (u.user_metadata ?? {}) as Record<string, any>;
  return {
    provider: "google",
    // 구글이 부여한 sub — Supabase 사용자 id 가 아니다. 계정 연결 키는 공급자 id 여야 한다.
    id: String(meta.provider_id ?? meta.sub ?? u.id),
    name: meta.full_name ?? meta.name,
    email: u.email ?? meta.email,
    avatarUrl: meta.avatar_url ?? meta.picture,
  };
}

const KAKAO_JS_KEY = "c80827032123a3e018388749472f759d";

async function ensureKakaoReady(): Promise<any> {
  // SDK 로딩 대기 — 약한 와이파이/3G 대응 위해 6초까지
  const deadline = Date.now() + 6000;
  while (!(window as any).Kakao && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const Kakao = (window as any).Kakao;
  if (!Kakao) {
    throw new Error(t("auth.kakao.loadFail"));
  }
  // index.html 인라인 초기화가 SDK 보다 먼저 실행돼 누락된 경우 복구
  if (!Kakao.isInitialized()) {
    try {
      Kakao.init(KAKAO_JS_KEY);
    } catch (e: any) {
      throw new Error(t("auth.kakao.initFail", undefined, { msg: e?.message ?? t("auth.kakao.unknown") }));
    }
  }
  return Kakao;
}

// Kakao JS SDK가 버전에 따라 콜백/Promise 양쪽을 쓰는 문제 해결용 어댑터.
// success/fail 콜백과 반환 Promise 중 먼저 settle 되는 쪽을 잡고, 타임아웃 안전망까지 건다.
function callKakaoApi<T>(
  fn: (opts: any) => any,
  opts: Record<string, any>,
  timeoutMs: number,
  timeoutMsg: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const err = (e: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(e?.error_description ?? e?.msg ?? String(e?.message ?? e ?? "unknown")));
    };
    const timer = setTimeout(() => err(new Error(timeoutMsg)), timeoutMs);
    try {
      const ret = fn({ ...opts, success: done, fail: err });
      // 신버전 SDK: Promise 반환
      if (ret && typeof ret.then === "function") {
        ret.then(done, err);
      }
    } catch (e) {
      err(e);
    }
  });
}

export async function signInWithKakao(): Promise<SocialResult> {
  const Kakao = await ensureKakaoReady();
  if (!Kakao.Auth?.login || !Kakao.API?.request) {
    throw new Error(t("auth.kakao.sdkBroken"));
  }

  await callKakaoApi<void>(
    Kakao.Auth.login.bind(Kakao.Auth),
    {
      // 이메일·프로필 동의 화면이 일관되게 뜨도록 scope 명시
      scope: "profile_nickname,profile_image,account_email",
      // 모바일에서 카카오톡 앱으로 빠져 콜백을 못 받는 케이스 차단
      throughTalk: false,
    },
    60000,
    t("auth.kakao.noResponse")
  );

  const userInfo = await callKakaoApi<any>(
    Kakao.API.request.bind(Kakao.API),
    { url: "/v2/user/me" },
    10000,
    t("auth.kakao.userInfoTimeout")
  );

  const account = userInfo.kakao_account ?? {};
  const profile = account.profile ?? {};

  // 여기까지는 "카카오에 로그인했다"일 뿐, 결에 로그인한 건 아니다.
  // 액세스 토큰을 서버로 보내 세션으로 바꾼다. 프로필을 서버로 보내지 않는 게 핵심이다 —
  // 보내면 누구든 남의 카카오 id 를 적어 보낼 수 있고, 그게 예전의 무자격 로그인이다.
  const accessToken = Kakao.Auth.getAccessToken?.();
  if (!accessToken) throw new Error(t("auth.kakao.sdkBroken"));
  await exchangeForSession("kakao", accessToken);

  return {
    provider: "kakao",
    id: String(userInfo.id),
    name: profile.nickname,
    email: account.email,
    avatarUrl: profile.thumbnail_image_url,
  };
}

/**
 * 공급자 액세스 토큰 → Supabase 세션.
 *
 * 서버는 토큰만 받아 공급자에게 되물어 신원을 확인한 뒤 1회용 token_hash 를 준다.
 * verifyOtp 가 그걸 세션으로 바꾼다 — Firebase 의 signInWithCustomToken 자리다.
 */
async function exchangeForSession(provider: "kakao" | "naver" | "google", accessToken: string): Promise<void> {
  const res = await fetch(api("/api/auth/social/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, accessToken }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? t("auth.social.sessionFail"));

  const { error } = await supabase.auth.verifyOtp({
    token_hash: body.tokenHash,
    type: "magiclink",
  });
  if (error) throw error;
}

/**
 * 리다이렉트 방식(서버 /api/auth/{kakao,naver}/callback)이 창으로 넘겨준
 * token_hash 를 세션으로 바꾼다.
 */
export async function consumeSocialTokenHash(tokenHash: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error) throw error;
}

export async function signOutAll() {
  try {
    await supabase.auth.signOut();
  } catch {}
  const Kakao = (window as any).Kakao;
  if (Kakao?.Auth?.getAccessToken?.() && Kakao.Auth.logout) {
    try {
      await new Promise((r) => Kakao.Auth.logout(r));
    } catch {}
  }
}

export function calculateAgeGroup(birthYear: number): string {
  const now = new Date().getFullYear();
  const age = now - birthYear;
  if (age < 20) return t("auth.ageGroup.teens");
  if (age < 30) return t("auth.ageGroup.20s");
  if (age < 40) return t("auth.ageGroup.30s");
  if (age < 50) return t("auth.ageGroup.40s");
  if (age < 60) return t("auth.ageGroup.50s");
  return t("auth.ageGroup.60plus");
}

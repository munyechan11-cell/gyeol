


// fetch with timeout — AI API가 영영 안 돌아오는 사고 방지
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 이 서비스의 공개 주소. OAuth redirect_uri 처럼 "밖에서 우리를 부를 주소"에 쓴다.
 * (오래 firebase.ts 에 있었지만 Firebase 와 아무 관계가 없다.)
 */
export const getBaseUrl = (): string => process.env.APP_URL || 'http://localhost:3000';

/**
 * 앱(정적 사이트)의 출처. OAuth 팝업이 결과를 postMessage 로 넘길 때 **이 출처에만** 준다.
 * '*' 로 보내면 팝업을 연 아무 창이나 1회용 로그인 토큰을 받는다.
 * 앱과 API 가 다른 서비스(Render Static Site + Web Service)라 API 주소로는 안 된다.
 * APP_ORIGIN 이 없으면 CORS 허용 목록의 첫 항목, 그것도 없으면(로컬 통합 실행) API 주소.
 */
export const getAppOrigin = (): string => {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, '');
  const first = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  return (first || getBaseUrl()).replace(/\/$/, '');
};

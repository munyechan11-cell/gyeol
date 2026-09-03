/**
 * API base URL 헬퍼.
 *
 * - Static Site 분리 후: VITE_API_URL 환경변수에 API 서비스 주소 지정
 *   예: https://gyeol-api.onrender.com
 * - 통합 배포(로컬 개발·과거 단일 서비스): VITE_API_URL 미설정 → same-origin 호출
 *
 * 사용:
 *   import { api, authHeaders } from "./lib/api";
 *   await fetch(api("/api/ai/floor-plan"), { headers: await authHeaders(), ... });
 */
import { supabase } from "./supabase";
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export const api = (path: string): string => {
  const p = path.startsWith("/") ? path : `/${path}`;
  return BASE ? `${BASE}${p}` : p;
};

/**
 * 인증이 필요한 API 호출용 헤더.
 *
 * 서버는 이 토큰에서 **요청자가 어느 매장인지** 읽는다. 그래서 본문에 storeId 를
 * 적어 보내도 서버가 그걸 믿지 않는다 — 남의 매장 정산 키를 바꿔치는 식의 요청이
 * 통하지 않는 이유다.
 *
 * 로그인 전이면 Authorization 을 아예 붙이지 않는다. 빈 Bearer 를 보내면 서버가
 * "토큰이 잘못됐다"고 답하게 되는데, 실제 원인은 로그인 안 함이라 진단이 흐려진다.
 */
export async function authHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}

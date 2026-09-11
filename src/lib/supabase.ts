import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase 클라이언트 — Firestore 를 대체한다.
 *
 * 여기 있는 키는 **공개용(publishable)** 이다. 클라이언트 번들에 들어가는 게 정상이며,
 * 이 키로 할 수 있는 일은 RLS 정책이 허용하는 범위뿐이다.
 * (Firestore 시절엔 이 자리의 웹 API 키만 있으면 익명 로그인으로 전 매장 데이터에
 *  접근할 수 있었다. 그 구멍은 RLS 로 막혔다 — supabase/migrations 참고.)
 * 비밀 키(service_role)는 서버에만 있고 여기 절대 오면 안 된다.
 */
const env = (import.meta as any).env ?? {};

export const SUPABASE_URL: string =
  env.VITE_SUPABASE_URL || "https://pxvkbvojpxavrandrqkp.supabase.co";

export const SUPABASE_PUBLISHABLE_KEY: string =
  env.VITE_SUPABASE_PUBLISHABLE_KEY || "sb_publishable___a4MY-b5lk_VZHRLh8Mtg_8LxAqVcO";

export const isSupabaseConfigured = !!SUPABASE_URL && !!SUPABASE_PUBLISHABLE_KEY;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    // 새로고침·재접속에도 로그인이 유지되도록 세션을 저장하고 토큰을 자동 갱신한다.
    persistSession: true,
    autoRefreshToken: true,
    // 구글 로그인이 리다이렉트로 돌아올 때 URL 에 실린 인증 코드를 세션으로 바꿔야 한다.
    // (전화번호 OTP 는 코드 입력 방식이라 이게 필요 없지만, 켜 둬도 그쪽엔 영향이 없다.)
    detectSessionInUrl: true,
  },
  realtime: {
    // 매장 하나가 여는 채널 수가 많지 않아 기본값으로 충분하다.
    params: { eventsPerSecond: 10 },
  },
});

/** 앱이 문서처럼 다루는 테이블 이름. save_doc 화이트리스트와 같은 집합이어야 한다. */
export type TableName =
  | "users"
  | "visits"
  | "coupons"
  | "tables"
  | "sections"
  | "communications"
  | "tier_overrides"
  | "menus"
  | "orders"
  | "reservations"
  | "photos"
  | "shifts"
  | "ingredients"
  | "expenses"
  | "marketing_drafts"
  | "print_jobs"
  | "app_state";

/**
 * Firestore 컬렉션 이름 → Postgres 테이블 이름.
 *
 * 앱 코드 곳곳이 아직 옛 이름을 쓴다. 한 번에 다 바꾸는 대신 여기서 흡수해,
 * 이름 변경과 저장소 교체가 같은 커밋에 섞이지 않게 한다.
 */
const TABLE_ALIASES: Record<string, TableName> = {
  Communications: "communications",
  tierOverrides: "tier_overrides",
  marketingDrafts: "marketing_drafts",
  appState: "app_state",
  print_jobs: "print_jobs",
};

export function resolveTable(name: string): TableName {
  return (TABLE_ALIASES[name] ?? name) as TableName;
}

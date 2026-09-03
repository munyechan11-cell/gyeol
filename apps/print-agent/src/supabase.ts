/**
 * Supabase 세션 + print_jobs 구독.
 *
 * **Firebase 때와 다른 점 둘.**
 *
 * 1) 세션이 만료된다. Firebase 커스텀 토큰은 한 번 저장해 두면 재시작할 때마다
 *    그대로 다시 로그인할 수 있었다. Supabase 는 액세스 토큰이 한 시간이고
 *    리프레시 토큰은 쓸 때마다 새 것으로 교체된다. 그래서 갱신될 때마다
 *    새 리프레시 토큰을 저장해 둔다 — 안 하면 매장 PC 를 껐다 켠 다음 날
 *    "재로그인 실패"가 뜬다.
 *
 * 2) 기기는 print_jobs 밖을 못 본다. 예전에는 에이전트가 users 문서에 직접
 *    하트비트를 쓰고 매장명을 읽었다. 그건 프린터에게 매장 전체를 열어 주는 것과
 *    같아서, 지금은 서버 엔드포인트 하나(/api/print-bridge/heartbeat)가 대신한다.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

import { config } from "./config";

const SUPABASE_URL =
  process.env.GYEOL_SUPABASE_URL || "https://pxvkbvojpxavrandrqkp.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  process.env.GYEOL_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable___a4MY-b5lk_VZHRLh8Mtg_8LxAqVcO";

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      // 저장은 electron-store 로 직접 한다 — 여기서는 localStorage 가 없다.
      persistSession: false,
      autoRefreshToken: true,
    },
  });
  // 토큰이 갱신될 때마다 새 리프레시 토큰을 붙잡아 둔다.
  client.auth.onAuthStateChange((_event, session) => {
    if (session?.refresh_token) config.set("refreshToken", session.refresh_token);
  });
  return client;
}

/** 페어링 — 서버가 준 1회용 토큰을 세션으로 바꾼다. */
export async function pairWithTokenHash(tokenHash: string): Promise<void> {
  const sb = getClient();
  const { data, error } = await sb.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error) throw error;
  if (!data.session?.refresh_token) throw new Error("세션을 받지 못했어요.");
  config.set("refreshToken", data.session.refresh_token);
}

/** 재시작 후 로그인 — 저장해 둔 리프레시 토큰으로 세션을 되살린다. */
export async function signInWithStoredToken(): Promise<void> {
  const refreshToken = config.get("refreshToken");
  if (!refreshToken) throw new Error("페어링이 필요해요.");
  const sb = getClient();
  const { data, error } = await sb.auth.refreshSession({ refresh_token: refreshToken });
  if (error) throw error;
  if (!data.session) throw new Error("세션 복구 실패 — 다시 페어링해 주세요.");
  config.set("refreshToken", data.session.refresh_token);
}

export interface PrintJob {
  id: string;
  storeId: string;
  type: "receipt" | "kitchen" | "test";
  payload: { storeName: string; order: any; footer?: string };
  printerName?: string | null;
  status: "pending" | "printing" | "printed" | "failed";
  attempts?: number;
  lastError?: string | null;
}

const toJob = (row: any): PrintJob => ({ ...(row?.data ?? {}), id: row?.id });

/**
 * 자기 매장의 pending 인쇄 작업 구독.
 *
 * 실시간 이벤트만 듣지 않는다 — 앱이 꺼져 있는 동안 쌓인 작업은 이벤트로 오지 않는다.
 * 붙자마자 밀린 것부터 한 번 훑고, 그 뒤로 들어오는 것을 듣는다.
 * 같은 작업이 두 번 올 수 있으므로(초기 조회 + 이벤트) 중복 처리는 호출처가 담당한다.
 */
export function subscribePendingJobs(
  storeId: string,
  onJob: (job: PrintJob) => void,
  onError?: (e: Error) => void
): () => void {
  const sb = getClient();

  void (async () => {
    const { data, error } = await sb
      .from("print_jobs")
      .select("*")
      .eq("storeId", storeId)
      .eq("status", "pending")
      .order("createdAt", { ascending: true })
      .limit(20);
    if (error) {
      onError?.(new Error(error.message));
      return;
    }
    (data ?? []).forEach((row) => onJob(toJob(row)));
  })();

  const channel: RealtimeChannel = sb
    .channel(`print_jobs:${storeId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "print_jobs", filter: `storeId=eq.${storeId}` },
      (payload) => {
        const job = toJob(payload.new);
        if (job.status === "pending") onJob(job);
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        onError?.(new Error(`인쇄 작업 구독 실패 (${status})`));
      }
    });

  return () => {
    void sb.removeChannel(channel);
  };
}

export async function markJob(
  jobId: string,
  patch: Partial<{ status: PrintJob["status"]; lastError: string | null; attempts: number; printedAt: string }>
) {
  const sb = getClient();
  const { error } = await sb.rpc("save_doc", { p_table: "print_jobs", p_id: jobId, p_patch: patch });
  if (error) throw new Error(error.message);
}

/**
 * 하트비트 겸 매장 정보 조회. 서버가 토큰에서 매장을 읽어 처리한다 —
 * 기기가 storeId 를 말하는 게 아니라, 서버가 토큰을 보고 안다.
 */
export async function heartbeat(): Promise<{ restaurantName?: string } | null> {
  try {
    const sb = getClient();
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;

    const res = await fetch(`${config.apiUrl()}/api/print-bridge/heartbeat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as { restaurantName?: string };
  } catch (e: any) {
    console.warn("[supabase] heartbeat skip", e?.message);
    return null;
  }
}

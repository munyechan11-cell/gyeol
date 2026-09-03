import type { RealtimeChannel } from "@supabase/supabase-js";

import { resolveTable, supabase } from "./supabase";

/**
 * 실시간 컬렉션 구독 — Firestore `onSnapshot` 의 자리.
 *
 * **의미가 하나 다르다.** onSnapshot 은 바뀔 때마다 컬렉션 **전체**를 다시 줬지만,
 * Postgres 실시간은 바뀐 **행 하나**만 준다. 앱의 setter 는 배열 전체를 받으므로,
 * 여기서 "처음 한 번 전체 조회 → 이후 델타를 로컬 배열에 반영" 으로 메운다.
 *
 * RLS 가 그대로 걸리므로 남의 매장 행은 조회에도 이벤트에도 나오지 않는다.
 */

/** DB 행을 앱이 쓰던 문서 모양으로 되돌린다. 앱은 `{ id, ...필드 }` 를 기대한다. */
function rowToDoc<T>(row: Record<string, unknown>): T {
  const data = (row.data ?? {}) as Record<string, unknown>;
  return { ...data, id: row.id } as T;
}

export interface SubscribeOptions {
  /** 좁힐 컬럼 (보통 storeId). 없으면 RLS 가 허용하는 전부. */
  column?: string;
  /** 위 컬럼의 값. */
  value?: string;
  /** 조회·구독 실패 시 호출. 침묵 실패를 막는다. */
  onError?: (e: unknown) => void;
  /** 첫 조회가 끝났을 때 한 번 호출 — 부팅 완료 판정에 쓴다. */
  onReady?: () => void;
}

/**
 * 테이블 하나를 구독한다.
 *
 * @returns 구독 해제 함수
 */
// 일부 도메인 타입(TierOverride 등)은 id 를 선언하지 않지만, DB 행에는 항상 있고
// rowToDoc 이 채워 넣는다. 그래서 제약을 느슨하게 둔다.
export function subscribeTable<T>(
  table: string,
  setRows: (rows: T[]) => void,
  opts: SubscribeOptions = {}
): () => void {
  const name = resolveTable(table);
  const { column, value, onError, onReady } = opts;

  // 로컬 사본 — 델타를 여기에 반영하고 통째로 setter 에 넘긴다.
  let rows: T[] = [];
  let cancelled = false;
  let channel: RealtimeChannel | null = null;

  const publish = () => {
    if (!cancelled) setRows([...rows]);
  };

  const fail = (e: unknown) => {
    // 침묵 실패 방지 — RLS 로 막힌 건지 네트워크인지 콘솔에 남긴다.
    console.error(`[realtime ${name}]`, (e as { code?: string })?.code, (e as Error)?.message ?? e);
    onError?.(e);
  };

  (async () => {
    // 1) 초기 스냅샷
    let q = supabase.from(name).select("*");
    if (column && value !== undefined) q = q.eq(column, value);
    const { data, error } = await q;
    if (cancelled) return;
    if (error) {
      fail(error);
      // 첫 조회가 실패해도 부팅은 끝내야 한다 — 로더에 갇히면 원인조차 못 본다.
      onReady?.();
      return;
    }
    rows = (data ?? []).map((r) => rowToDoc<T>(r as Record<string, unknown>));
    publish();
    onReady?.();

    // 2) 이후 델타
    const filter = column && value !== undefined ? `${column}=eq.${value}` : undefined;
    channel = supabase
      .channel(`${name}:${filter ?? "all"}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: name, ...(filter ? { filter } : {}) },
        (payload) => {
          if (cancelled) return;
          const next = payload.new as Record<string, unknown> | null;
          const prev = payload.old as Record<string, unknown> | null;

          const idOf = (r: T) => (r as { id?: string }).id;
          if (payload.eventType === "DELETE") {
            const id = (prev?.id ?? "") as string;
            rows = rows.filter((r) => idOf(r) !== id);
          } else if (next) {
            const doc = rowToDoc<T>(next);
            const i = rows.findIndex((r) => idOf(r) === idOf(doc));
            if (i >= 0) rows[i] = doc;
            else rows.push(doc);
          }
          publish();
        }
      )
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") fail(err ?? status);
      });
  })().catch(fail);

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}

/** 문서 하나만 읽는다(구독 없음). appState 처럼 한 번만 필요한 값에. */
export async function fetchDoc<T>(table: string, id: string): Promise<T | null> {
  const name = resolveTable(table);
  const { data, error } = await supabase.from(name).select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error(`[fetchDoc ${name}]`, error.message);
    return null;
  }
  return data ? rowToDoc<T>(data as Record<string, unknown>) : null;
}

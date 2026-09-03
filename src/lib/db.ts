import { resolveTable, supabase } from "./supabase";
import { t } from "./i18n";
import { showToast } from "./toast";

/**
 * 문서 저장 계층 — Firestore 의 `updateFirestoreDoc` 자리를 그대로 대체한다.
 *
 * 앱은 문서를 통째로 다루고(`{ id, ...data }`) 부분 패치로 저장한다. 그 계약을 유지하려고
 * 저장은 서버 함수 `save_doc(table, id, patch)` 로 보낸다. 병합과 원자 연산(increment,
 * arrayUnion)이 DB 안에서 한 번에 처리되므로, 두 직원이 동시에 작업해도 한쪽이 사라지지 않는다.
 * (클라이언트에서 읽고-합쳐-쓰면 그 사고가 난다.)
 */

const OFFLINE_QUEUE_KEY = "gyeol:offline_queue";

interface QueueOp {
  table: string;
  id: string;
  data?: unknown;
  isDelete?: boolean;
}

function loadQueue(): QueueOp[] {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveQueue(q: QueueOp[]) {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
  } catch {
    // 저장 공간 부족·차단 — 큐를 못 남겨도 앱은 계속 돌아야 한다.
  }
}

// ============================================================
// 원자 연산 — Firestore 의 FieldValue 자리.
//
// Firestore 는 SDK 인스턴스로 sentinel 을 표현했지만, 여기서는 평범한 객체다.
// save_doc 이 `__op` 를 보고 DB 안에서 처리한다.
// ============================================================

/** 숫자 필드를 원자적으로 더한다(음수면 뺀다). 재고 차감·적립금 갱신용. */
export const increment = (by: number) => ({ __op: "increment", by }) as const;

/** 배열에 중복 없이 덧붙인다. 기존 순서는 유지된다. */
export const arrayUnion = (...values: unknown[]) => ({ __op: "arrayUnion", values }) as const;

/** 배열에서 값을 뺀다. */
export const arrayRemove = (...values: unknown[]) => ({ __op: "arrayRemove", values }) as const;

/** 필드를 지운다. (null 로 덮어쓰는 것과 다르다 — 키 자체가 사라진다) */
export const deleteField = () => ({ __op: "delete" }) as const;

/**
 * undefined 를 재귀적으로 걷어낸다.
 *
 * JSON 직렬화는 undefined 를 조용히 버리는데, 배열 안에서는 null 로 바뀐다.
 * 그 차이가 데이터를 오염시키므로 보내기 전에 정리한다. null 은 의미가 있으므로 남긴다.
 * `__op` 객체는 분해하지 않고 그대로 통과시킨다.
 */
function stripUndefined<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((v) => stripUndefined(v)).filter((v) => v !== undefined) as unknown as T;
  }
  if ("__op" in (input as Record<string, unknown>)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

/**
 * 서버 응답 대기 상한(ms).
 *
 * 네트워크가 끊긴 환경에서 저장이 무한정 pending 이면, 이 저장을 await 하는
 * 로그인·가입 흐름이 끝나지 않아 버튼이 스피너인 채로 굳는다. 사용자 눈에는
 * "로그인이 안 된다"로 보인다. 상한을 두고 넘으면 큐에 넣고 진행시킨다.
 */
const WRITE_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol("write-timeout");

// PostgrestBuilder 는 Promise 가 아니라 thenable 이라 PromiseLike 로 받는다.
async function withTimeout<T>(p: PromiseLike<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), WRITE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 네트워크 문제인가 — 그렇다면 큐에 넣고 나중에 다시 보낸다. */
function isNetworkError(e: unknown): boolean {
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  return /fetch|network|timeout|ECONN|Failed to fetch/i.test(msg);
}

/**
 * 문서를 저장한다(없으면 생성, 있으면 부분 병합).
 *
 * @param table Firestore 컬렉션 이름을 그대로 넘겨도 된다 — 내부에서 테이블명으로 옮긴다.
 * @param id    문서 id (uuid). app_state 만 문자열 키.
 * @param data  부분 패치. increment()/arrayUnion() 등을 섞어 보낼 수 있다.
 */
export async function saveDoc(table: string, id: string, data?: unknown): Promise<void> {
  const t0 = resolveTable(table);
  const payload = stripUndefined(data ?? {});
  try {
    const settled = await withTimeout(
      supabase.rpc("save_doc", { p_table: t0, p_id: id, p_patch: payload })
    );
    if (settled === TIMED_OUT) {
      saveQueue([...loadQueue(), { table: t0, id, data: payload }]);
      showToast(t("fs.networkUnstable"), "info");
      return;
    }
    if (settled.error) throw settled.error;
  } catch (e: unknown) {
    if (isNetworkError(e)) {
      saveQueue([...loadQueue(), { table: t0, id, data: payload }]);
      showToast(t("fs.networkUnstable"), "info");
      return;
    }
    // 42501 = RLS 가 막았다. 남의 매장 데이터를 건드렸거나 권한이 없다는 뜻.
    const code = (e as { code?: string })?.code;
    if (code === "42501" || code === "PGRST301") showToast(t("fs.permissionDenied"), "error");
    else showToast(t("fs.saveError"), "error");
    throw e;
  }
}

/** 일괄 쓰기 한 건. patch 를 주면 저장, remove 를 주면 삭제. */
export interface DocWrite {
  table: string;
  id: string;
  patch?: unknown;
  remove?: boolean;
}

/**
 * 여러 문서를 **한 트랜잭션으로** 저장/삭제한다.
 *
 * 낱개 saveDoc 을 여러 번 부르는 것과 다르다. 앱에는 묶여야만 맞는 쓰기가 있다 —
 * 예를 들어 테이블을 비울 때 "미결제 주문들을 취소" 와 "그 테이블을 dirty 로" 는
 * 함께 되거나 함께 안 돼야 한다. 앞만 되면 손님이 앉아 있는 것처럼 보이고,
 * 뒤만 되면 유령 주문이 매출·재고 집계에 영원히 남는다.
 *
 * 오프라인 큐에 넣지 않는다. 큐는 낱개 쓰기를 순서대로 다시 보내는 구조라,
 * 묶임이 필요한 쓰기를 거기 넣으면 정확히 그 성질이 깨진다. 실패는 실패로 알린다.
 */
export async function saveDocs(writes: DocWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const payload = writes.map((w) => ({
    table: resolveTable(w.table),
    id: w.id,
    ...(w.remove ? { delete: true } : { patch: stripUndefined(w.patch ?? {}) }),
  }));
  try {
    const settled = await withTimeout(supabase.rpc("save_docs", { p_writes: payload }));
    if (settled === TIMED_OUT) throw new Error("timeout");
    if (settled.error) throw settled.error;
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "42501" || code === "PGRST301") showToast(t("fs.permissionDenied"), "error");
    else showToast(t("fs.saveError"), "error");
    throw e;
  }
}

/** 문서를 지운다. */
export async function removeDoc(table: string, id: string): Promise<void> {
  const t0 = resolveTable(table);
  try {
    const settled = await withTimeout(
      supabase.rpc("delete_doc", { p_table: t0, p_id: id })
    );
    if (settled === TIMED_OUT) {
      saveQueue([...loadQueue(), { table: t0, id, isDelete: true }]);
      showToast(t("fs.networkUnstable"), "info");
      return;
    }
    if (settled.error) throw settled.error;
  } catch (e: unknown) {
    if (isNetworkError(e)) {
      saveQueue([...loadQueue(), { table: t0, id, isDelete: true }]);
      showToast(t("fs.networkUnstable"), "info");
      return;
    }
    showToast(t("fs.saveError"), "error");
    throw e;
  }
}

// 동시 flush 차단 — 'online' 이벤트와 다른 트리거가 겹쳐 두 번 돌면 같은 op 가 두 번 나간다.
let flushing = false;

/** 큐에 쌓인 저장을 다시 보낸다. 재연결 시 자동 호출된다. */
export function flushOfflineQueue(): void {
  if (flushing) return;
  const q = loadQueue();
  if (q.length === 0) return;
  flushing = true;
  saveQueue([]);
  (async () => {
    for (const op of q) {
      try {
        if (op.isDelete) await removeDoc(op.table, op.id);
        else await saveDoc(op.table, op.id, op.data);
      } catch {
        // 여전히 실패 — 다시 큐로. (권한 오류라면 계속 실패하겠지만 토스트로 이미 알렸다)
        saveQueue([...loadQueue(), op]);
      }
    }
  })().finally(() => {
    flushing = false;
  });
}

// online 리스너 1회 등록 — HMR·동적 import 반복 시 중복 방지
if (typeof window !== "undefined" && !(window as any).__gyeolOnlineListenerSetup) {
  (window as any).__gyeolOnlineListenerSetup = true;
  window.addEventListener("online", flushOfflineQueue);
}

/** 새 문서 id. Postgres 가 uuid 를 요구하므로 앱도 uuid 를 만든다. */
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // 구형 브라우저 폴백 — uuid v4 모양만 맞춘다.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

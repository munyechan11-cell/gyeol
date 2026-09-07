import { supabase } from "./supabase";

/**
 * 서버(DB 함수)가 대신 쓰는 손님 흐름.
 *
 * 손님 기기는 방문 기록·적립·쿠폰을 **직접 쓰지 않는다.** 정책을 열면 손님이 자기
 * 쿠폰과 적립금을 마음대로 만들 수 있다. 대신 규칙을 아는 함수를 부른다 —
 * 함수는 사장님 설정(적립 방식·등급 보상·리뷰 쿠폰)을 읽어 그대로 적용한다.
 * 규칙은 supabase/migrations 의 record_visit / claim_review_coupon 에 있다.
 */

export interface RecordVisitResult {
  /** 오늘 첫 방문이었는가. 아니면 자리 점유만 갱신됐다. */
  newVisit: boolean;
  /** 이번에 적립된 스탬프/포인트. */
  rewardDelta: number;
  /** 이번에 발급된 등급 쿠폰 종류(없으면 null). */
  couponIssued: string | null;
}

/** QR 진입 — 방문(하루 1회)·적립·등급 쿠폰·테이블 점유를 한 번에. */
export async function recordVisitRpc(
  storeId: string,
  tableNumber: number,
  amount?: number
): Promise<RecordVisitResult> {
  const { data, error } = await supabase.rpc("record_visit", {
    p_store_id: storeId,
    p_table_number: tableNumber,
    p_amount: amount ?? null,
  });
  if (error) throw error;
  const r = (data ?? {}) as Partial<RecordVisitResult>;
  return {
    newVisit: !!r.newVisit,
    rewardDelta: Number(r.rewardDelta ?? 0),
    couponIssued: r.couponIssued ?? null,
  };
}

/** 결제 때 리뷰를 남긴 뒤 — 매장이 리뷰 쿠폰을 켰으면 세션당 한 번 발급된다. */
export async function claimReviewCoupon(
  storeId: string,
  tableNumber: number
): Promise<{ issued: boolean; reason?: string }> {
  const { data, error } = await supabase.rpc("claim_review_coupon", {
    p_store_id: storeId,
    p_table_number: tableNumber,
  });
  if (error) throw error;
  const r = (data ?? {}) as { issued?: boolean; reason?: string };
  return { issued: !!r.issued, reason: r.reason };
}

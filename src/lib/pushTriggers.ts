/**
 * 사장님 디바이스로 푸시를 보내는 클라이언트 트리거.
 * store.tsx 의 핵심 흐름(주문 생성, 결제 요청, 직원 가입 요청, 쿠폰 요청) 끝에서 호출.
 *
 * 보안:
 *   서버가 Supabase 세션 토큰을 검증한다. 세션은 OTP 나 소셜 검증을 통과해야만
 *   생기므로, 예전처럼 익명 토큰으로는 부를 수 없다.
 *
 * 실패는 silent — 푸시는 부가 기능이지 핵심 흐름을 막아선 안 됨.
 */
import { api } from "./api";
import { supabase } from "./supabase";

type PushKind = "new-order" | "payment-request" | "staff-join" | "coupon-request" | "test";

interface SendInput {
  storeId: string;
  kind: PushKind;
  title: string;
  body: string;
  focusUrl?: string;
  tag?: string;
}

export async function sendOwnerPush(input: SendInput): Promise<void> {
  if (!input.storeId) return;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return; // 로그인 안 된 상태 — 발송 시도조차 안 함

    void fetch(api("/api/push/send-to-owner"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      keepalive: true,
    });
  } catch (e: any) {
    console.warn("[push trigger] silent fail", e?.message);
  }
}

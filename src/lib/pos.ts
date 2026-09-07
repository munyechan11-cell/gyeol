import { api, authHeaders } from "./api";

/**
 * 주문을 외부 POS(푸드테크)로 넘긴다.
 *
 * 주문 id 만 보낸다. 매장의 POS 설정·품목 코드는 서버가 DB 에서 읽는다 — 예전엔
 * 손님 기기가 사장님의 POS 키를 알아야 했는데, 손님은 이제 사장님 행의 비밀 필드를
 * 읽지 않는다. 서버는 요청자가 그 주문의 손님(또는 그 매장 사람)인지 확인한다.
 *
 * @returns 전달 성공 여부. 매장에 POS 연동이 없으면 true(건너뜀).
 */
export async function relayOrderToPos(orderId: string): Promise<boolean> {
  try {
    const res = await fetch(api("/api/order/relay-to-pos"), {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ orderId }),
    });
    if (!res.ok) {
      console.warn(`[POS relay] HTTP ${res.status}`);
      return false;
    }
    const result = await res.json().catch(() => ({}));
    return result?.success !== false;
  } catch (e) {
    console.warn("[POS relay] network error", e);
    return false;
  }
}

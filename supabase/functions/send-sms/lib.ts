// ============================================================
// send-sms 의 순수 부분.
//
// index.ts 는 Deno 런타임 위에서만 돌아 테스트하기 어렵다. 판단이 들어가는 두
// 가지 — 번호 변환과 서명 검증 — 를 여기 떼어 두면 평범한 테스트로 지킬 수 있다.
// 둘 다 조용히 틀리면 티가 안 난다: 번호가 틀리면 문자가 엉뚱한 곳으로 가고,
// 서명이 틀리면 아무나 발송시킬 수 있다.
// ============================================================

/** "821012345678" · "+82-10-1234-5678" → "01012345678". 알리고는 국내 표기를 받는다. */
export function toDomestic(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('82')) return `0${digits.slice(2)}`;
  return digits;
}

export interface SignatureHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Standard Webhooks 서명 검증.
 *
 * 이게 없으면 함수 URL 을 아는 누구나 OTP 문자를 아무 번호로 쏘게 할 수 있다 —
 * 발송 비용이 그대로 청구되고, 남의 번호를 괴롭히는 데 쓰인다.
 *
 * 서명 대상은 `{id}.{timestamp}.{body}` 이고, 키는 `whsec_` 뒤의 base64 를 디코드한 것이다.
 *
 * @param nowMs 재전송 판정 기준 시각. 테스트가 시간을 고정할 수 있게 인자로 받는다.
 */
export async function verifySignature(
  headers: SignatureHeaders,
  rawBody: string,
  secret: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;

  // 오래된 요청 재전송 차단(5분). 서명이 맞아도 옛 요청은 받지 않는다.
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = await sign(rawBody, id, timestamp, secret);

  // 헤더에는 서명이 여러 개 실릴 수 있다(키 교체 중). 하나라도 맞으면 통과.
  return signature
    .split(' ')
    .map((part) => part.split(',')[1])
    .some((sig) => sig === expected);
}

/** 검증에 쓰는 서명 계산. 테스트가 유효한 요청을 만들 때도 쓴다. */
export async function sign(
  rawBody: string,
  id: string,
  timestamp: string,
  secret: string
): Promise<string> {
  const raw = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  const keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

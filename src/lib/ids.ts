// 문서 id 생성기는 lib/db.ts 로 옮겼다.
// Postgres 가 uuid 를 요구하므로 앱도 uuid 를 만든다 (예전에는 자체 형식이었다).
// 기존 import 경로를 깨지 않으려고 여기서 재수출한다.
export { newId } from "./db";

export function formatPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  if (digits.length < 4) return digits;
  if (digits.length < 8) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * 전화번호를 계정 매칭용 표준형(국내 0-prefix 숫자열)으로 정규화.
 *
 * 왜 digitsOnly 만으로는 부족한가:
 *   SMS 인증(Firebase Phone Auth)은 항상 E.164("+821012345678")를 돌려주는데,
 *   이 값이 users.phone 에 그대로 저장된 이력이 있다. digitsOnly 로만 비교하면
 *   저장값 "821012345678" 과 사용자가 입력한 "01012345678" 이 영원히 불일치해
 *   그 계정은 전화번호로 로그인이 불가능해진다.
 *   → 비교하는 양쪽 모두 이 함수를 거치면, 이미 오염된 문서도 정상 매칭된다.
 *
 * 판정 규칙: 국내 번호는 항상 0 으로 시작한다(010·02·031…). 따라서 0 으로 시작하지
 * 않으면서 82 로 시작하면 국가코드가 붙은 값이다 — 82 를 떼고 0 을 붙인다.
 * toE164KR() 의 역변환과 정확히 대칭이다.
 */
export function normalizePhone(raw: string): string {
  const d = digitsOnly(raw || "");
  if (!d.startsWith("0") && d.startsWith("82")) return "0" + d.slice(2);
  return d;
}

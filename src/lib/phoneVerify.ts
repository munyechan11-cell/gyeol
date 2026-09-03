import { supabase } from "./supabase";

/**
 * 전화번호 OTP — Supabase Auth.
 *
 * **Firebase 때와 구조가 다르다.** Firebase 에서는 전화 인증이 로그인과 별개였고,
 * 메인 세션을 파괴하지 않으려고 "보조 앱"을 따로 띄우고 reCAPTCHA 를 붙여야 했다.
 * Supabase 에서는 **OTP 검증이 곧 로그인**이다. verifyOtp 가 세션을 만들어 주므로
 * 보조 앱도 reCAPTCHA 도 필요 없다.
 *
 * 그리고 이게 예전 구조의 결함 하나를 원천적으로 없앤다. 예전 로그인에는 비밀번호가
 * 없었다 — 전화번호가 맞으면 그대로 로그인이었다. 이제는 그 번호로 오는 문자를
 * 받아야만 들어올 수 있다.
 *
 * 흐름:
 *   1. sendVerificationCode("010-1234-5678")  → SMS 발송
 *   2. confirmCode("010-1234-5678", "123456") → 세션 생성 + 검증된 번호 반환
 *
 * ⚠️ SMS 는 건당 비용이 든다. 발송 직전 E.164 변환과 정규식 검증으로 누수를 막는다.
 */

/** 한국식 전화번호("010-1234-5678", "01012345678") → E.164("+821012345678"). 실패 시 null. */
export function toE164KR(phone: string): string | null {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  // 82 로 시작하면 이미 국가코드 포함, 0 으로 시작하면 0 을 떼고 +82.
  if (digits.startsWith("82")) return `+${digits}`;
  if (!digits.startsWith("0")) return null;
  return `+82${digits.slice(1)}`;
}

/** E.164 한국 번호 정합성 — 발송 비용이 새는 걸 막는 마지막 관문. */
export function isValidKRPhone(phone: string): boolean {
  const e164 = toE164KR(phone);
  if (!e164) return false;
  return /^\+82[1-9]\d{7,10}$/.test(e164);
}

/**
 * 인증번호 SMS 발송.
 *
 * @throws "invalid-phone" — 형식이 틀리면 발송 자체를 하지 않는다(비용 누수 차단)
 * @throws Supabase 오류 — 발송 한도 초과 등
 */
export async function sendVerificationCode(phone: string): Promise<void> {
  const e164 = toE164KR(phone);
  if (!e164 || !isValidKRPhone(phone)) throw new Error("invalid-phone");

  const { error } = await supabase.auth.signInWithOtp({
    phone: e164,
    // 계정이 없으면 만든다 — 가입과 로그인이 같은 흐름이다.
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
}

/**
 * 6자리 코드 검증. 성공하면 **로그인 세션이 만들어진다.**
 *
 * @returns 검증된 전화번호(E.164)와 auth 사용자 id. 호출처는 이 id 로
 *          public.users 행을 만들거나 갱신한다.
 */
export async function confirmCode(
  phone: string,
  code: string
): Promise<{ userId: string; phone: string }> {
  const e164 = toE164KR(phone);
  if (!e164) throw new Error("invalid-phone");

  const { data, error } = await supabase.auth.verifyOtp({
    phone: e164,
    token: code,
    type: "sms",
  });
  if (error) throw error;
  const userId = data.user?.id;
  if (!userId) throw new Error("no-session");
  return { userId, phone: data.user?.phone ? `+${data.user.phone}` : e164 };
}

/** 로그아웃 — 세션 파기. */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** 지금 로그인된 auth 사용자 id (없으면 null). */
export async function currentAuthUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

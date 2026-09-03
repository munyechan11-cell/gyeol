import { api } from "./api";
import { t } from "./i18n";
import { isAcceptablePassword, phoneLoginEmail, MIN_PASSWORD_LENGTH } from "./phoneLoginEmail";
import { supabase } from "./supabase";

/**
 * 전화번호 + 비밀번호 로그인 — **문자 발송 없이.**
 *
 * 전화번호 OTP 는 문자 발송 업체가 있어야 동작한다. 그게 준비되기 전까지 쓰는
 * 경로다. 예전처럼 "번호만 맞으면 로그인"으로 되돌리지 않는 게 핵심이다 —
 * 그건 남의 번호만 알면 그 사람 계정에 들어가던 구멍이었다.
 *
 * 번호는 아이디, 비밀번호는 자격 증명. 그릇은 Supabase 의 이메일 로그인을 쓰지만
 * 사용자는 그 주소를 볼 일이 없다(phoneLoginEmail 참고).
 *
 * 문자가 붙으면 이 경로를 없애는 게 아니라 **함께 둔다** — OTP 는 기기를 바꿔도
 * 들어갈 수 있고, 비밀번호는 문자가 안 올 때 들어갈 수 있다.
 */

export { MIN_PASSWORD_LENGTH };

/**
 * 가입. 서버를 거치는 이유는 이메일 확인 절차 때문이다 —
 * 받을 사람이 없는 주소라 확인 메일을 태우면 아무도 가입을 못 끝낸다.
 *
 * @throws 사람이 읽을 수 있는 메시지
 */
export async function signUpWithPhonePassword(phone: string, password: string): Promise<void> {
  if (!phoneLoginEmail(phone)) throw new Error(t("auth.phone.invalid"));
  if (!isAcceptablePassword(password)) throw new Error(t("auth.phone.weakPassword"));

  const res = await fetch(api("/api/auth/phone/signup"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.error === "already-registered") throw new Error(t("auth.phone.alreadyRegistered"));
    if (body?.error === "invalid-phone") throw new Error(t("auth.phone.invalid"));
    if (body?.error === "weak-password") throw new Error(t("auth.phone.weakPassword"));
    throw new Error(body?.error ?? t("auth.phone.signupFailed"));
  }

  // 가입 직후 바로 로그인시킨다. 여기서 멈추면 사용자는 방금 만든 계정으로
  // 다시 로그인 화면을 마주하게 된다.
  await signInWithPhonePassword(phone, password);
}

/** 로그인. 성공하면 세션이 생기고, 그때부터 store 의 login() 이 통과한다. */
export async function signInWithPhonePassword(phone: string, password: string): Promise<string> {
  const email = phoneLoginEmail(phone);
  if (!email) throw new Error(t("auth.phone.invalid"));

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // 번호가 없는 것과 비밀번호가 틀린 것을 구분해 알려주지 않는다 —
    // 구분해 주면 번호를 훑어 "가입된 번호 목록"을 만들 수 있다.
    throw new Error(t("auth.phone.wrongCredentials"));
  }
  const userId = data.user?.id;
  if (!userId) throw new Error(t("auth.phone.wrongCredentials"));
  return userId;
}

/** 비밀번호 변경 — 지금 로그인한 본인만. */
export async function changePassword(newPassword: string): Promise<void> {
  if (!isAcceptablePassword(newPassword)) throw new Error(t("auth.phone.weakPassword"));
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

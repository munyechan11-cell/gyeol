// ============================================================
// 전화번호 → 로그인 계정 키.
//
// **이 파일은 아무것도 import 하지 않는다.** 앱과 서버가 같은 규칙을 써야 하는데,
// 한쪽이라도 다르게 계산하면 가입한 번호로 로그인이 안 된다. 규칙을 한 벌만 둔다.
// (i18n 사전을 두 벌 두었다가 겪은 것과 같은 종류의 사고다.)
//
// 왜 이메일 모양인가 — Supabase 의 이메일 로그인은 기본으로 켜져 있고 공급자가
// 필요 없다. 전화번호 로그인을 켜려면 문자 발송 업체를 붙여야 하는데, 그게 지금
// 없다. 번호를 계정 키로 삼되 그릇만 이메일을 쓴다. 사용자는 이 주소를 볼 일이
// 없다 — 화면에는 전화번호만 나온다.
//
// ⚠️ 정규화가 이 파일의 핵심이다. "010-1234-5678", "01012345678",
//    "+821012345678" 은 **같은 사람**이다. 하나라도 다른 키로 떨어지면 그 사람은
//    계정이 둘로 갈라지고, 적립·쿠폰이 어느 한쪽에만 남는다. 예전에 E.164 를
//    그대로 저장해 로그인이 영구히 잠겼던 것과 정확히 같은 자리다.
// ============================================================

/** 어떤 표기로 들어와도 국내 표기("01012345678")로. 형식이 아니면 null. */
export function normalizeLoginPhone(phone: string): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  const local = digits.startsWith('82') ? `0${digits.slice(2)}` : digits;
  // 국내 휴대폰만 받는다. 010 외 번호(011 등)도 통과시킨다 — 아직 쓰는 사람이 있다.
  if (!/^01[016789]\d{7,8}$/.test(local)) return null;
  return local;
}

/** 전화번호 → auth 계정 이메일. 형식이 틀리면 null(호출부가 400 으로 거른다). */
export function phoneLoginEmail(phone: string): string | null {
  const local = normalizeLoginPhone(phone);
  return local ? `p${local}@phone.gyeol.app` : null;
}

/** 비밀번호 최소 조건. 서버와 화면이 같은 기준을 써야 "왜 거부됐는지"가 맞는다. */
export const MIN_PASSWORD_LENGTH = 8;

export function isAcceptablePassword(pw: string): boolean {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD_LENGTH;
}

import { describe, expect, it, vi } from "vitest";

// 이 테스트는 순수 변환 함수만 본다. 모듈이 supabase 클라이언트를 import 하므로
// 실제 네트워크 클라이언트가 만들어지지 않도록 막아 둔다.
vi.mock("./supabase", () => ({ supabase: { auth: {} } }));

import { isValidKRPhone, toE164KR } from "./phoneVerify";

/**
 * SMS 는 건당 비용이 든다. 이 두 함수가 발송 직전의 마지막 관문이라,
 * 느슨해지면 잘못된 번호로 돈이 샌다.
 */
describe("toE164KR", () => {
  it("국내 형식을 E.164 로 바꾼다", () => {
    expect(toE164KR("010-1234-5678")).toBe("+821012345678");
    expect(toE164KR("01012345678")).toBe("+821012345678");
    expect(toE164KR("010 1234 5678")).toBe("+821012345678");
  });

  it("이미 국가코드가 붙은 값은 그대로 둔다", () => {
    expect(toE164KR("+821012345678")).toBe("+821012345678");
    expect(toE164KR("821012345678")).toBe("+821012345678");
  });

  it("서울 지역번호도 받는다", () => {
    expect(toE164KR("02-123-4567")).toBe("+8221234567");
  });

  it("변환할 수 없으면 null", () => {
    expect(toE164KR("")).toBe(null);
    expect(toE164KR("abc")).toBe(null);
    expect(toE164KR("1234")).toBe(null); // 0 으로 시작하지 않고 82 도 아님
  });
});

describe("isValidKRPhone", () => {
  it("정상 휴대폰·지역번호를 통과시킨다", () => {
    expect(isValidKRPhone("010-1234-5678")).toBe(true);
    expect(isValidKRPhone("02-123-4567")).toBe(true);
  });

  it("[비용] 빈 값·문자·너무 짧은 번호는 막는다", () => {
    expect(isValidKRPhone("")).toBe(false);
    expect(isValidKRPhone("abc")).toBe(false);
    expect(isValidKRPhone("010-1")).toBe(false);
  });

  it("[비용] 지나치게 긴 번호는 막는다", () => {
    expect(isValidKRPhone("010-1234-5678-9999")).toBe(false);
  });

  it("[비용] 0 으로 시작하지 않는 국내 번호는 막는다", () => {
    expect(isValidKRPhone("1012345678")).toBe(false);
  });
});

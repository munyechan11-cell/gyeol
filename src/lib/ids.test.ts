import { describe, it, expect } from "vitest";
import { digitsOnly, formatPhoneNumber, normalizePhone } from "./ids";
import { newId } from "./db";

describe("normalizePhone", () => {
  // 이 함수는 '인증을 마친 회원부터 차례로 로그인이 잠기던' 사고를 막는 지점이다.
  // SMS 인증(Firebase Phone Auth)이 돌려주는 E.164 가 users.phone 에 그대로 저장된 이력이
  // 있어서, 저장값과 사용자 입력이 같은 표준형으로 수렴하지 않으면 그 계정은 영영 못 들어온다.
  it("국내 표기를 숫자열로 정규화한다", () => {
    expect(normalizePhone("010-1234-5678")).toBe("01012345678");
    expect(normalizePhone("010 1234 5678")).toBe("01012345678");
    expect(normalizePhone("01012345678")).toBe("01012345678");
  });

  it("E.164 국가코드를 국내 0-prefix 로 되돌린다", () => {
    expect(normalizePhone("+821012345678")).toBe("01012345678");
    expect(normalizePhone("821012345678")).toBe("01012345678");
    expect(normalizePhone("+82 10 1234 5678")).toBe("01012345678");
  });

  it("지역번호도 국가코드를 되돌린다", () => {
    expect(normalizePhone("+82212345678")).toBe("0212345678");
    expect(normalizePhone("+8221234567")).toBe("021234567");
  });

  it("0 으로 시작하면 국가코드로 오인하지 않는다", () => {
    // '82' 를 포함하지만 국내 번호 — 손대면 안 된다
    expect(normalizePhone("01082000000")).toBe("01082000000");
    expect(normalizePhone("0212345678")).toBe("0212345678");
    expect(normalizePhone("0311234567")).toBe("0311234567");
  });

  it("빈 값과 null-ish 를 빈 문자열로 처리한다", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(undefined as unknown as string)).toBe("");
  });

  it("멱등이다 — 두 번 정규화해도 같다", () => {
    for (const v of ["010-1234-5678", "+821012345678", "0212345678", "021234567"]) {
      expect(normalizePhone(normalizePhone(v))).toBe(normalizePhone(v));
    }
  });

  it("[회귀] 오염된 저장값과 사용자 입력이 같은 키로 수렴한다", () => {
    const stored = normalizePhone("+821012345678"); // 인증이 덮어쓴 값
    const typed = normalizePhone("010-1234-5678"); // 로그인 화면 입력
    expect(stored).toBe(typed);
  });
});

describe("digitsOnly", () => {
  it("숫자만 남긴다", () => {
    expect(digitsOnly("010-1234-5678")).toBe("01012345678");
    expect(digitsOnly("+82 10")).toBe("8210");
    expect(digitsOnly("abc")).toBe("");
  });
});

describe("formatPhoneNumber", () => {
  it("자릿수에 따라 하이픈을 넣는다", () => {
    expect(formatPhoneNumber("010")).toBe("010");
    expect(formatPhoneNumber("0101")).toBe("010-1");
    expect(formatPhoneNumber("01012345678")).toBe("010-1234-5678");
  });

  it("11자리를 넘는 입력은 잘라낸다", () => {
    expect(formatPhoneNumber("010123456789999")).toBe("010-1234-5678");
  });
});

describe("newId", () => {
  it("호출마다 다른 값을 낸다", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });

  // Postgres 의 uuid 컬럼에 그대로 들어가야 한다. 형식이 어긋나면 저장이 통째로 실패한다.
  it("uuid 형식이다 — Postgres uuid 컬럼이 받아야 한다", () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

import { describe, expect, it } from "vitest";

import { isAcceptablePassword, normalizeLoginPhone, phoneLoginEmail } from "./phoneLoginEmail";

/**
 * 이 규칙이 흔들리면 "가입은 됐는데 로그인이 안 된다"가 된다.
 * 표기가 달라도 같은 사람이면 같은 키로 떨어져야 한다.
 */
describe("normalizeLoginPhone", () => {
  it("표기가 달라도 같은 번호는 같은 값이 된다", () => {
    const forms = ["01012345678", "010-1234-5678", "010 1234 5678", "+82 10-1234-5678", "821012345678"];
    const got = new Set(forms.map(normalizeLoginPhone));
    expect(got).toEqual(new Set(["01012345678"]));
  });

  it("011 같은 옛 번호도 받는다 — 아직 쓰는 사람이 있다", () => {
    expect(normalizeLoginPhone("011-234-5678")).toBe("0112345678");
  });

  it("휴대폰이 아닌 번호는 거부한다", () => {
    expect(normalizeLoginPhone("02-123-4567")).toBeNull();
    expect(normalizeLoginPhone("1588-1588")).toBeNull();
    expect(normalizeLoginPhone("")).toBeNull();
    expect(normalizeLoginPhone("010123")).toBeNull();
  });
});

describe("phoneLoginEmail", () => {
  it("같은 사람은 같은 계정 키를 받는다", () => {
    expect(phoneLoginEmail("010-1234-5678")).toBe(phoneLoginEmail("+821012345678"));
  });

  it("다른 사람은 다른 키를 받는다", () => {
    expect(phoneLoginEmail("01012345678")).not.toBe(phoneLoginEmail("01012345679"));
  });

  it("형식이 틀리면 null — 계정을 만들지 않는다", () => {
    expect(phoneLoginEmail("02-123-4567")).toBeNull();
  });
});

describe("isAcceptablePassword", () => {
  it("8자 미만은 거부", () => {
    expect(isAcceptablePassword("1234567")).toBe(false);
    expect(isAcceptablePassword("12345678")).toBe(true);
  });
});

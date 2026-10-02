// @vitest-environment jsdom
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "../../lib/i18n";
import { TERMS } from "../../lib/terms";

/**
 * 사장님 가입 화면의 선택 동의(통화 음성 예약).
 * 체크했을 때만 동의 시각이 login() 으로 넘어가는지, 그리고 체크박스·'보기'가 가입을 제출하지 않는지.
 */

const login = vi.fn(async (_input: unknown) => ({}));
const signUp = vi.fn(async (..._a: unknown[]) => {});
const signIn = vi.fn(async (..._a: unknown[]) => {});

vi.mock("../../store/store", () => ({ useStore: () => ({ login, users: [] }) }));
vi.mock("../../lib/phoneAuth", () => ({
  signUpWithPhonePassword: (...a: unknown[]) => signUp(...a),
  signInWithPhonePassword: (...a: unknown[]) => signIn(...a),
  MIN_PASSWORD_LENGTH: 8,
}));
vi.mock("../../lib/auth", () => ({
  signInWithGoogle: vi.fn(), signInWithKakao: vi.fn(), signInWithNaver: vi.fn(), consumeGoogleRedirect: vi.fn(async () => null),
}));
vi.mock("../../lib/realtime", () => ({ fetchDoc: vi.fn(async () => null) }));
vi.mock("../../lib/phoneVerify", () => ({ currentAuthUserId: vi.fn(async () => null) }));
vi.mock("../../components/ui/PhoneVerifyModal", () => ({ PhoneVerifyModal: () => null }));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));

import OwnerLogin from "./Login";

const tx = (k: string) => t(k, "ko");

function fillSignup() {
  fireEvent.click(screen.getByText(tx("ownerLogin.tab.signup")));
  fireEvent.change(screen.getByLabelText(tx("ownerLogin.field.name")), { target: { value: "홍길동" } });
  fireEvent.change(screen.getByLabelText(tx("ownerLogin.field.phone")), { target: { value: "01012345678" } });
  fireEvent.change(screen.getByLabelText(tx("auth.phone.password")), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText(tx("ownerLogin.field.restaurant")), { target: { value: "결식당" } });
}
const voiceCheckbox = () => screen.getByRole("checkbox", { name: TERMS.voice.title });
const submit = async () => {
  await act(async () => { fireEvent.click(screen.getByText(tx("ownerLogin.btn.signup")).closest("button")!); });
};

beforeEach(() => {
  login.mockClear();
  signUp.mockClear();
  signIn.mockClear();
  sessionStorage.clear();
  render(<MemoryRouter><OwnerLogin /></MemoryRouter>);
});
afterEach(cleanup);

describe("사장님 가입 — 통화 음성 예약 선택 동의", () => {
  it("체크하고 가입하면 동의 시각이 login() 으로 간다", async () => {
    fillSignup();
    fireEvent.click(voiceCheckbox());
    expect(voiceCheckbox().getAttribute("aria-checked")).toBe("true");
    await submit();
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    const arg = login.mock.calls[0][0] as { voiceCallConsentAt?: string; role: string };
    expect(arg.role).toBe("owner");
    expect(Date.parse(arg.voiceCallConsentAt!)).not.toBeNaN();
    expect(Math.abs(Date.now() - Date.parse(arg.voiceCallConsentAt!))).toBeLessThan(10_000);
  });

  it("기본값은 체크 해제 — 체크하지 않고 가입하면 동의를 보내지 않는다", async () => {
    fillSignup();
    expect(voiceCheckbox().getAttribute("aria-checked")).toBe("false");
    await submit();
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect((login.mock.calls[0][0] as { voiceCallConsentAt?: string }).voiceCallConsentAt).toBeUndefined();
  });

  it("체크했다 풀면 보내지 않는다", async () => {
    fillSignup();
    fireEvent.click(voiceCheckbox());
    fireEvent.click(voiceCheckbox());
    await submit();
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    expect((login.mock.calls[0][0] as { voiceCallConsentAt?: string }).voiceCallConsentAt).toBeUndefined();
  });

  it("체크박스·'보기' 를 눌러도 가입이 제출되지 않는다 (form 안의 버튼은 type=button 이어야 한다)", async () => {
    fillSignup();
    fireEvent.click(voiceCheckbox());
    fireEvent.click(screen.getByText(t("login.view", "ko")));
    await act(async () => {});
    expect(signUp).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("'보기' 는 약관 본문을 연다", () => {
    fillSignup();
    fireEvent.click(screen.getByText(t("login.view", "ko")));
    expect(screen.getByRole("dialog", { name: TERMS.voice.title })).toBeTruthy();
  });

  it("선택 동의라고 표시한다 — 필수 배지가 아니다", () => {
    fillSignup();
    expect(screen.getByText(tx("ownerLogin.optionalConsents"))).toBeTruthy();
    expect(screen.getByText(t("login.optional", "ko"))).toBeTruthy();
    expect(screen.queryByText(t("login.required", "ko"))).toBeNull();
  });

  it("로그인 탭에는 동의 항목이 없다", () => {
    expect(screen.queryByRole("checkbox", { name: TERMS.voice.title })).toBeNull();
  });
});

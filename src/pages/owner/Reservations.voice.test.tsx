// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceDraft } from "../../lib/voiceReservation";
import { t } from "../../lib/i18n";

/**
 * 예약 화면에서 음성 초안이 모달을 채우는 연결부.
 * 음성 시트(VoiceReserve)와 스토어는 모의하고, "초안 → 모달 → 저장" 사이에서 우리 코드가 하는 일만 본다.
 */

const STORE = "S";
const addReservation = vi.fn(async (_d: unknown) => {});
const saveDoc = vi.fn(async (..._a: unknown[]) => {});

let storeState: any;
const baseStore = () => ({
  effectiveStoreId: STORE,
  reservations: [] as any[],
  tables: [
    { id: "t1", number: 1, storeId: STORE, seats: 2, x: 0, y: 0 },
    { id: "t2", number: 2, storeId: STORE, seats: 4, x: 0, y: 0 },
    { id: "t3", number: 3, storeId: STORE, seats: 6, x: 0, y: 0 },
  ],
  users: [{ id: STORE, role: "owner", name: "사장", restaurantName: "결식당", voiceCallConsentAt: "2026-10-02T00:00:00Z" }],
  visits: [] as any[],
  currentUser: { id: STORE, role: "owner", name: "사장", restaurantName: "결식당", voiceCallConsentAt: "2026-10-02T00:00:00Z" },
  addReservation,
  updateReservation: vi.fn(),
  deleteReservation: vi.fn(),
});

vi.mock("../../store/store", () => ({ useStore: () => storeState }));
vi.mock("../../components/layout/OwnerShell", () => ({
  OwnerShell: ({ children, headerRight }: any) => <div>{headerRight}{children}</div>,
}));
vi.mock("../../lib/db", () => ({ saveDoc: (...a: unknown[]) => saveDoc(...a), deleteField: () => ({ __op: "delete" }) }));
vi.mock("../../lib/messaging", () => ({ sendKakaoMessage: vi.fn(), sendPhysicalSms: vi.fn() }));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
// 시트는 모의 — 열렸는지와 넘겨받은 props 를 보고, 버튼으로 "초안이 만들어졌다"를 흉내 낸다.
let sheetProps: any = null;
let nextDraft: VoiceDraft;
vi.mock("./reservations/VoiceReserve", () => ({
  VoiceReserve: (p: any) => {
    sheetProps = p;
    return p.open ? <button onClick={() => p.onDraft(nextDraft)}>__emit_draft__</button> : null;
  },
}));

import OwnerReservations from "./Reservations";

const tx = (k: string, p?: Record<string, string | number>) => t(k, "ko", p);

const FULL: VoiceDraft = {
  date: "2026-10-03", time: "19:00", partySize: 4, customerName: "김철수", customerPhone: "01012345678",
  memo: "유아 의자", transcript: "내일 저녁 7시 네 명 김철수 공일공 일이삼사", uncertain: [],
};

async function openWithDraft(d: VoiceDraft) {
  nextDraft = d;
  render(<OwnerReservations />);
  fireEvent.click(screen.getByLabelText(tx("voiceRes.btn.open")));
  await act(async () => { fireEvent.click(screen.getByText("__emit_draft__")); });
}

beforeEach(() => {
  storeState = baseStore();
  sheetProps = null;
  addReservation.mockClear();
  saveDoc.mockClear();
});
afterEach(cleanup);

describe("예약 화면 ← 음성 초안", () => {
  it("헤더 버튼이 시트를 열고, 동의 상태와 사장님 여부를 시트에 넘긴다", () => {
    render(<OwnerReservations />);
    expect(sheetProps.open).toBe(false);
    fireEvent.click(screen.getByLabelText(tx("voiceRes.btn.open")));
    expect(sheetProps.open).toBe(true);
    expect(sheetProps.consented).toBe(true);
    expect(sheetProps.canGrantConsent).toBe(true);
  });

  it("동의가 없는 매장이면 consented=false · 직원이면 canGrantConsent=false", () => {
    storeState.users = [{ id: STORE, role: "owner", name: "사장" }];
    storeState.currentUser = { id: "STAFF1", role: "staff", name: "직원" };
    render(<OwnerReservations />);
    expect(sheetProps.consented).toBe(false);
    expect(sheetProps.canGrantConsent).toBe(false);
  });

  it("초안이 오면 예약 모달이 값으로 채워지고, 시트는 닫힌다(부모가 닫는 건 시트 책임)", async () => {
    await openWithDraft(FULL);
    expect(screen.getByDisplayValue("010-1234-5678")).toBeTruthy(); // 전화번호는 하이픈 포맷
    expect(screen.getByDisplayValue("2026-10-03")).toBeTruthy();
    expect(screen.getByDisplayValue("19:00")).toBeTruthy();
    expect(screen.getByDisplayValue("유아 의자")).toBeTruthy();
    // "새 예약" 은 헤더 버튼과 모달 제목 두 곳에 있다 — 모달이 떴다면 둘 이상.
    expect(screen.getAllByText(tx("ores.newTitle")).length).toBeGreaterThanOrEqual(2);
  });

  it("전부 확실하면 '모두 맞는지 확인' 배너, AI 가 들은 내용(전사)이 접힌 채로 있다", async () => {
    await openWithDraft(FULL);
    expect(screen.getByText(tx("voiceRes.result.bannerAll"))).toBeTruthy();
    expect(screen.getByText(tx("voiceRes.result.transcript"))).toBeTruthy();
    expect(screen.queryByText(tx("voiceRes.checkHint"))).toBeNull();
  });

  it("못 들은 칸 + 모델이 불확실하다고 한 칸이 '다시 확인' 으로 표시되고 배너에 이름이 나온다", async () => {
    await openWithDraft({ ...FULL, time: undefined, customerPhone: undefined, uncertain: ["partySize"] });
    const banner = screen.getByText((c) => c.startsWith(tx("voiceRes.result.banner", { fields: "" }).split(":")[0]));
    // 화면 순서: 이름 → 전화번호 → 날짜 → 시간 → 인원 중 해당하는 것
    expect(banner.textContent).toContain(`${tx("voiceRes.field.phone")}, ${tx("voiceRes.field.time")}, ${tx("voiceRes.field.party")}`);
    // 전화번호·시간 입력칸에 빨간 안내 (인원은 스테퍼라 배너로만)
    expect(screen.getAllByText(tx("voiceRes.checkHint")).length).toBe(2);
  });

  it("사장님이 고친 칸의 '다시 확인' 표시는 사라지고 나머지는 남는다", async () => {
    await openWithDraft({ ...FULL, time: undefined, customerPhone: undefined, uncertain: [] });
    const phone = screen.getByPlaceholderText("010-0000-0000");
    fireEvent.change(phone, { target: { value: "01099998888" } });
    expect(screen.getAllByText(tx("voiceRes.checkHint")).length).toBe(1); // 시간만 남음
    expect((screen.getByPlaceholderText("010-0000-0000") as HTMLInputElement).value).toBe("010-9999-8888");
  });

  it("테이블은 인원을 수용하는 빈 테이블로 제안한다 (4명 → 2번 테이블)", async () => {
    await openWithDraft(FULL);
    // 테이블 입력칸은 숫자 입력(inputMode=numeric)이면서 값이 '2'
    const numeric = screen.getAllByRole("textbox").filter((e) => (e as HTMLInputElement).inputMode === "numeric");
    expect(numeric.some((e) => (e as HTMLInputElement).value === "2")).toBe(true);
  });

  it("같은 시간에 2번 테이블이 이미 예약돼 있으면 3번을 제안한다", async () => {
    storeState.reservations = [{ id: "r", storeId: STORE, date: "2026-10-03", time: "19:00", tableNumber: 2, status: "confirmed", partySize: 2, customerName: "a", customerPhone: "1" }];
    await openWithDraft(FULL);
    const numeric = screen.getAllByRole("textbox").filter((e) => (e as HTMLInputElement).inputMode === "numeric");
    expect(numeric.some((e) => (e as HTMLInputElement).value === "3")).toBe(true);
  });

  it("저장하면 예약 데이터만 간다 — 전사·voice 메타는 저장되지 않는다", async () => {
    await openWithDraft(FULL);
    await act(async () => { fireEvent.click(screen.getByText(tx("omenus.save"))); });
    expect(addReservation).toHaveBeenCalledTimes(1);
    const data = addReservation.mock.calls[0][0] as Record<string, unknown>;
    expect(data).toEqual({
      storeId: STORE, date: "2026-10-03", time: "19:00", tableNumber: 2, partySize: 4,
      customerName: "김철수", customerPhone: "010-1234-5678", memo: "유아 의자",
    });
    expect(JSON.stringify(data)).not.toMatch(/transcript|voice|공일공/);
  });

  it("이름·전화가 비어 있으면 저장이 막힌다 — 초안이 불완전해도 그대로 저장되지 않는다", async () => {
    await openWithDraft({ ...FULL, customerName: undefined, customerPhone: undefined });
    await act(async () => { fireEvent.click(screen.getByText(tx("omenus.save"))); });
    expect(addReservation).not.toHaveBeenCalled();
  });

  it("같은 번호의 단골이 있으면 등록 고객으로 연결한다 (이름은 등록된 이름)", async () => {
    storeState.users = [...storeState.users, { id: "C1", role: "customer", name: "김철수(단골)", phone: "01012345678", status: "active" }];
    storeState.visits = [{ id: "v", storeId: STORE, customerId: "C1" }];
    await openWithDraft({ ...FULL, customerName: "김철수" });
    // 선택된 고객은 입력칸이 아니라 텍스트로 보인다
    expect(screen.getByText("김철수(단골)")).toBeTruthy();
    expect(screen.queryByText("김철수")).toBeNull();
  });

  it("다른 매장 단골(방문 기록 없음)과는 연결하지 않는다 — 번호가 같아도 그 손님 정보를 끌어오지 않는다", async () => {
    storeState.users = [...storeState.users, { id: "C9", role: "customer", name: "남의단골", phone: "01012345678", status: "active" }];
    storeState.visits = [{ id: "v", storeId: "OTHER", customerId: "C9" }];
    await openWithDraft(FULL);
    expect(screen.queryByText("남의단골")).toBeNull();
    expect(screen.getByText("김철수")).toBeTruthy(); // 말한 이름 그대로 게스트로
  });
});

describe("동의 저장 · 철회", () => {
  it("동의: 사장님 문서에 시각을 쓴다", async () => {
    render(<OwnerReservations />);
    await act(async () => { await sheetProps.onGrantConsent(); });
    expect(saveDoc).toHaveBeenCalledTimes(1);
    const [table, id, patch] = saveDoc.mock.calls[0] as [string, string, any];
    expect([table, id]).toEqual(["users", STORE]);
    expect(Date.parse(patch.voiceCallConsentAt)).not.toBeNaN();
  });

  it("철회: 필드를 지운다 · 이후 consented=false 로 바뀐다(구독이 늦어도 로컬 값이 먼저)", async () => {
    render(<OwnerReservations />);
    expect(sheetProps.consented).toBe(true);
    await act(async () => { await sheetProps.onWithdrawConsent(); });
    expect(saveDoc).toHaveBeenCalledWith("users", STORE, { voiceCallConsentAt: { __op: "delete" } });
    expect(sheetProps.consented).toBe(false);
  });

  it("방금 동의하면 구독이 아직 반영되지 않아도 consented=true", async () => {
    storeState.users = [{ id: STORE, role: "owner", name: "사장" }];
    storeState.currentUser = { id: STORE, role: "owner", name: "사장" };
    render(<OwnerReservations />);
    expect(sheetProps.consented).toBe(false);
    await act(async () => { await sheetProps.onGrantConsent(); });
    expect(sheetProps.consented).toBe(true);
  });

  it("매장 id 가 없으면 동의를 저장하지 않고 던진다(시트가 실패 토스트를 띄운다)", async () => {
    storeState.effectiveStoreId = undefined;
    render(<OwnerReservations />);
    await expect(sheetProps.onGrantConsent()).rejects.toThrow();
    expect(saveDoc).not.toHaveBeenCalled();
  });
});


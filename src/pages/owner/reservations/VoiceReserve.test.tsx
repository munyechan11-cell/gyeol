// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordError } from "../../../lib/wavRecorder";
import { VoiceDraftError, type VoiceDraft } from "../../../lib/voiceReservation";
import { t } from "../../../lib/i18n";

vi.mock("../../../lib/wavRecorder", async (orig) => ({
  ...(await orig<typeof import("../../../lib/wavRecorder")>()),
  startRecording: vi.fn(),
}));
vi.mock("../../../lib/voiceReservation", async (orig) => ({
  ...(await orig<typeof import("../../../lib/voiceReservation")>()),
  requestVoiceDraft: vi.fn(),
}));
vi.mock("../../../lib/toast", () => ({ showToast: vi.fn() }));

import { startRecording } from "../../../lib/wavRecorder";
import { requestVoiceDraft } from "../../../lib/voiceReservation";
import { VoiceReserve } from "./VoiceReserve";

const L = "ko" as const;
const tx = (key: string, params?: Record<string, string | number>) => t(key, L, params);

const DRAFT: VoiceDraft = { date: "2026-10-03", time: "19:00", partySize: 4, customerName: "김철수", customerPhone: "01012345678", transcript: "내일 7시 네 명", uncertain: [] };

function fakeRecording(over: Partial<{ seconds: number; silent: boolean; trackMuted: boolean }> = {}) {
  const cancel = vi.fn();
  const stop = vi.fn(async () => ({ wav: new ArrayBuffer(4096), seconds: 5, peak: 0.4, rms: 0.1, trackMuted: false, silent: false, ...over }));
  return { rec: { stop, cancel }, stop, cancel };
}

function setup(over: Partial<React.ComponentProps<typeof VoiceReserve>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    consented: true,
    canGrantConsent: true,
    onGrantConsent: vi.fn(async () => {}),
    onWithdrawConsent: vi.fn(async () => {}),
    onDraft: vi.fn(),
    ...over,
  };
  const utils = render(<VoiceReserve {...props} />);
  return { props, ...utils };
}

beforeEach(() => {
  vi.mocked(startRecording).mockReset();
  vi.mocked(requestVoiceDraft).mockReset();
});
afterEach(cleanup);

describe("동의", () => {
  it("동의 전에는 시작 버튼이 없고, 체크해야 '동의하고 시작'이 켜진다", async () => {
    const { props } = setup({ consented: false });
    expect(screen.queryByText(tx("voiceRes.btn.start"))).toBeNull();
    const agree = screen.getByText(tx("voiceRes.consent.btn")).closest("button") as HTMLButtonElement;
    expect(agree.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(agree.disabled).toBe(false);
    await act(async () => { fireEvent.click(agree); });
    expect(props.onGrantConsent).toHaveBeenCalledTimes(1);
  });

  it("직원은 동의를 대신할 수 없다 — 안내만 보이고 체크박스·시작 버튼이 없다", () => {
    setup({ consented: false, canGrantConsent: false });
    expect(screen.getByText(tx("voiceRes.consent.staff"))).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(tx("voiceRes.btn.start"))).toBeNull();
  });

  it("동의 저장이 실패하면 시작 화면으로 넘어가지 않는다(토스트 + 동의 화면 유지)", async () => {
    const { props } = setup({ consented: false, onGrantConsent: vi.fn(async () => { throw new Error("x"); }) });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.consent.btn")).closest("button")!); });
    expect(props.onGrantConsent).toHaveBeenCalled();
    expect(screen.queryByText(tx("voiceRes.btn.start"))).toBeNull();
  });

  it("동의 철회는 확인을 거치고, 거절하면 아무 일도 없다", async () => {
    const { props } = setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.consent.withdraw"))); });
    expect(props.onWithdrawConsent).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.consent.withdraw"))); });
    expect(props.onWithdrawConsent).toHaveBeenCalledTimes(1);
  });

  it("직원에게는 철회 링크가 없다", () => {
    setup({ canGrantConsent: false });
    expect(screen.queryByText(tx("voiceRes.consent.withdraw"))).toBeNull();
  });
});

describe("모드 · 상대방 고지", () => {
  it("통화 중 모드에서만 고지 문구를 보여 준다", () => {
    setup();
    expect(screen.getByText(new RegExp(tx("voiceRes.notice.script").slice(0, 10)))).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: tx("voiceRes.mode.after") }));
    expect(screen.queryByText(new RegExp(tx("voiceRes.notice.script").slice(0, 10)))).toBeNull();
    expect(screen.getByText(tx("voiceRes.mode.after.desc"))).toBeTruthy();
  });
});

describe("녹음 → 초안", () => {
  it("시작 → 끝내고 분석 → 서버 호출 → 초안 전달 후 닫힌다", async () => {
    const { rec, stop, cancel } = fakeRecording();
    vi.mocked(startRecording).mockResolvedValue(rec);
    vi.mocked(requestVoiceDraft).mockResolvedValue(DRAFT);
    const { props } = setup();

    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    expect(await screen.findByText(tx("voiceRes.btn.stop"))).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.stop"))); });
    await waitFor(() => expect(props.onDraft).toHaveBeenCalledWith(DRAFT));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(requestVoiceDraft).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled(); // stop 으로 정상 종료 — 취소가 아니다
  });

  it("무음이면 서버를 부르지 않고 '통화가 마이크를 막았을 수 있다'는 안내와 대안을 보여 준다", async () => {
    const { rec } = fakeRecording({ silent: true });
    vi.mocked(startRecording).mockResolvedValue(rec);
    const { props } = setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await act(async () => { fireEvent.click(await screen.findByText(tx("voiceRes.btn.stop"))); });
    expect(await screen.findByText(tx("voiceRes.err.silent"))).toBeTruthy();
    expect(tx("voiceRes.err.silent")).toContain(tx("voiceRes.mode.after")); // 대안(통화 후 말하기)을 이름으로 안내
    expect(requestVoiceDraft).not.toHaveBeenCalled();
    expect(props.onDraft).not.toHaveBeenCalled();
    expect(screen.getByText(tx("voiceRes.btn.start"))).toBeTruthy(); // 다시 시도 가능
  });

  it("너무 짧으면(1.5초 미만) 서버를 부르지 않는다 · 정확히 1.5초는 통과", async () => {
    vi.mocked(startRecording).mockResolvedValue(fakeRecording({ seconds: 1.0 }).rec);
    setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await act(async () => { fireEvent.click(await screen.findByText(tx("voiceRes.btn.stop"))); });
    expect(await screen.findByText(tx("voiceRes.err.tooShort"))).toBeTruthy();
    expect(requestVoiceDraft).not.toHaveBeenCalled();

    cleanup();
    vi.mocked(startRecording).mockResolvedValue(fakeRecording({ seconds: 1.5 }).rec);
    vi.mocked(requestVoiceDraft).mockResolvedValue(DRAFT);
    setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await act(async () => { fireEvent.click(await screen.findByText(tx("voiceRes.btn.stop"))); });
    await waitFor(() => expect(requestVoiceDraft).toHaveBeenCalledTimes(1));
  });

  const startErr: Array<[RecordError["code"], string]> = [
    ["permission", "voiceRes.err.permission"],
    ["busy", "voiceRes.err.busy"],
    ["no-mic", "voiceRes.err.noMic"],
    ["unsupported", "voiceRes.err.unsupported"],
  ];
  for (const [code, key] of startErr) {
    it(`마이크 시작 실패(${code}) → 해당 안내`, async () => {
      vi.mocked(startRecording).mockRejectedValue(new RecordError(code));
      setup();
      await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
      expect(await screen.findByText(tx(key))).toBeTruthy();
    });
  }

  it("마이크 점유(busy) 안내는 대안 두 가지(통화 후 말하기 · 다른 기기)를 말한다", () => {
    const m = tx("voiceRes.err.busy");
    expect(m).toContain(tx("voiceRes.mode.after"));
    expect(m).toMatch(/태블릿|PC/);
  });

  const serverErr: Array<[VoiceDraftError["code"], string]> = [
    ["disabled", "voiceRes.err.disabled"],
    ["rate", "voiceRes.err.rate"],
    ["network", "voiceRes.err.network"],
    ["unauthorized", "voiceRes.err.unauthorized"],
    ["failed", "voiceRes.err.failed"],
    ["consent", "voiceRes.consent.staff"],
  ];
  for (const [code, key] of serverErr) {
    it(`서버 오류(${code}) → 해당 안내 · 초안은 전달되지 않는다`, async () => {
      vi.mocked(startRecording).mockResolvedValue(fakeRecording().rec);
      vi.mocked(requestVoiceDraft).mockRejectedValue(new VoiceDraftError(code));
      const { props } = setup();
      await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
      await act(async () => { fireEvent.click(await screen.findByText(tx("voiceRes.btn.stop"))); });
      expect(await screen.findByText(tx(key))).toBeTruthy();
      expect(props.onDraft).not.toHaveBeenCalled();
    });
  }
});

describe("마이크 누수 방지", () => {
  it("권한 창이 떠 있는 동안 시작을 또 눌러도 녹음은 한 번만 시작한다", async () => {
    let resolveStart!: (r: ReturnType<typeof fakeRecording>["rec"]) => void;
    vi.mocked(startRecording).mockImplementation(() => new Promise((res) => { resolveStart = res; }));
    setup();
    const btn = screen.getByText(tx("voiceRes.btn.start")).closest("button")!;
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(startRecording).toHaveBeenCalledTimes(1);
    await act(async () => { resolveStart(fakeRecording().rec); });
  });

  it("권한 창을 기다리는 사이 시트를 닫으면, 나중에 열린 마이크를 곧바로 놓는다", async () => {
    let resolveStart!: (r: ReturnType<typeof fakeRecording>["rec"]) => void;
    vi.mocked(startRecording).mockImplementation(() => new Promise((res) => { resolveStart = res; }));
    const { props } = setup();
    fireEvent.click(screen.getByText(tx("voiceRes.btn.start")));
    fireEvent.click(screen.getByLabelText(tx("voiceRes.btn.close")));
    expect(props.onClose).toHaveBeenCalled();

    const late = fakeRecording();
    await act(async () => { resolveStart(late.rec); });
    expect(late.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(tx("voiceRes.btn.stop"))).toBeNull();
  });

  it("녹음 중 취소하면 마이크를 놓고 시작 화면으로 돌아간다", async () => {
    const { rec, cancel } = fakeRecording();
    vi.mocked(startRecording).mockResolvedValue(rec);
    setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await act(async () => { fireEvent.click(await screen.findByText(tx("voiceRes.btn.cancel"))); });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText(tx("voiceRes.btn.start"))).toBeTruthy();
    expect(requestVoiceDraft).not.toHaveBeenCalled();
  });

  it("녹음 중 화면이 사라져도(페이지 이동) 마이크를 놓는다", async () => {
    const { rec, cancel } = fakeRecording();
    vi.mocked(startRecording).mockResolvedValue(rec);
    const { unmount } = setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await screen.findByText(tx("voiceRes.btn.stop"));
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("90초 자동 종료 신호(onAutoStop)가 오면 사용자가 누른 것처럼 분석을 진행한다", async () => {
    const { rec, stop } = fakeRecording();
    let auto!: () => void;
    vi.mocked(startRecording).mockImplementation(async (o) => { auto = o!.onAutoStop!; return rec; });
    vi.mocked(requestVoiceDraft).mockResolvedValue(DRAFT);
    const { props } = setup();
    await act(async () => { fireEvent.click(screen.getByText(tx("voiceRes.btn.start"))); });
    await act(async () => { auto(); });
    await waitFor(() => expect(props.onDraft).toHaveBeenCalledWith(DRAFT));
    expect(stop).toHaveBeenCalledTimes(1);
    // 자동 종료와 수동 종료가 겹쳐도 두 번 분석하지 않는다
    expect(requestVoiceDraft).toHaveBeenCalledTimes(1);
  });
});

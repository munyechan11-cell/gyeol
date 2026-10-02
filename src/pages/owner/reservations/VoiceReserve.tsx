import { useEffect, useRef, useState } from "react";
import { Mic, Square, X, Copy, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { AgreeRow } from "../../../components/ui/AgreeRow";
import { TermsModal } from "../../../components/ui/TermsModal";
import { TERMS } from "../../../lib/terms";
import { useLanguage, t } from "../../../lib/i18n";
import { showToast } from "../../../lib/toast";
import { useModalChrome } from "../../../lib/useModalChrome";
import { cn } from "../../../lib/cn";
import { MAX_SECONDS, RecordError, startRecording, type Recording } from "../../../lib/wavRecorder";
import { requestVoiceDraft, VoiceDraftError, type VoiceDraft } from "../../../lib/voiceReservation";

type Phase = "idle" | "recording" | "analyzing";
type Mode = "speaker" | "after";

/** 이 길이보다 짧으면 말이 거의 없었다고 본다. 서버의 최소 크기 검사보다 먼저 사용자에게 알려 준다. */
const MIN_SECONDS = 1.5;

function errorKey(e: unknown): string {
  if (e instanceof RecordError) {
    return {
      unsupported: "voiceRes.err.unsupported",
      permission: "voiceRes.err.permission",
      "no-mic": "voiceRes.err.noMic",
      busy: "voiceRes.err.busy",
      unknown: "voiceRes.err.failed",
    }[e.code];
  }
  if (e instanceof VoiceDraftError) {
    return {
      disabled: "voiceRes.err.disabled",
      consent: "voiceRes.consent.staff",
      rate: "voiceRes.err.rate",
      unauthorized: "voiceRes.err.unauthorized",
      network: "voiceRes.err.network",
      failed: "voiceRes.err.failed",
    }[e.code];
  }
  return "voiceRes.err.failed";
}

/**
 * 통화 음성으로 예약 초안 만들기.
 *
 * 두 가지 쓰임:
 *  - 통화 중(스피커폰): 폰 마이크로 스피커 소리를 듣는다. 폰이 통화 중 마이크를 막으면 안 될 수 있다 —
 *    그때는 아래 "통화 후 말하기"나 다른 기기를 안내한다.
 *  - 통화 후 말하기: 끊은 뒤 사장님이 내용을 말로 불러 준다. 어느 기기에서나 된다.
 *
 * 결과는 **초안**이다. 부모가 예약 모달을 채워 열고, 저장은 사장님이 누른다.
 */
export function VoiceReserve({
  open,
  onClose,
  consented,
  canGrantConsent,
  onGrantConsent,
  onWithdrawConsent,
  onDraft,
}: {
  open: boolean;
  onClose: () => void;
  consented: boolean;
  /** 이 매장의 사장님 본인인가. 직원은 동의를 대신할 수 없다. */
  canGrantConsent: boolean;
  onGrantConsent: () => Promise<void>;
  onWithdrawConsent: () => Promise<void>;
  onDraft: (draft: VoiceDraft) => void;
}) {
  const lang = useLanguage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>("speaker");
  const [agreed, setAgreed] = useState(false);
  const [viewingTerm, setViewingTerm] = useState(false);
  const [grantBusy, setGrantBusy] = useState(false);
  const [errKey, setErrKey] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const recRef = useRef<Recording | null>(null);
  const startedAt = useRef(0);
  const finishing = useRef(false);
  // 마이크 권한 창이 응답 없이 떠 있는 동안의 중복 시작·늦은 시작을 막는다.
  const [starting, setStarting] = useState(false);
  const startGen = useRef(0);
  // 90초 자동 종료가 렌더 시점의 낡은 finish 를 부르지 않게 항상 최신 것을 가리킨다.
  const finishRef = useRef<() => Promise<void>>(async () => {});

  const cancelRecording = () => {
    recRef.current?.cancel();
    recRef.current = null;
  };

  const close = () => {
    startGen.current++; // 아직 허용 창을 기다리는 시작이 있으면 그것이 끝나도 녹음을 열지 않는다
    setStarting(false);
    cancelRecording();
    setPhase("idle");
    setErrKey(null);
    setLevel(0);
    onClose();
  };
  useModalChrome(open, close);

  // 열려 있는 채로 사라지면(페이지 이동) 마이크를 놓는다.
  useEffect(() => () => { recRef.current?.cancel(); recRef.current = null; }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => clearInterval(id);
  }, [phase]);

  // 동의가 철회돼 닫혔다 다시 열리면 체크가 남아 있지 않게.
  useEffect(() => { if (!open) setAgreed(false); }, [open]);

  if (!open) return null;

  const start = async () => {
    if (starting) return;
    setErrKey(null);
    finishing.current = false;
    const gen = ++startGen.current;
    setStarting(true);
    try {
      // 클릭 핸들러 안에서 바로 호출해야 한다(아이폰 Safari 의 오디오 시작 조건).
      const rec = await startRecording({ onLevel: setLevel, onAutoStop: () => void finishRef.current() });
      if (gen !== startGen.current) { rec.cancel(); return; } // 기다리는 사이 시트가 닫혔다 — 마이크를 바로 놓는다
      recRef.current = rec;
      startedAt.current = Date.now();
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      if (gen === startGen.current) setErrKey(errorKey(e));
    } finally {
      if (gen === startGen.current) setStarting(false);
    }
  };

  const finish = async () => {
    const rec = recRef.current;
    if (!rec || finishing.current) return;
    finishing.current = true;
    recRef.current = null;
    setPhase("analyzing");
    setLevel(0);
    try {
      const r = await rec.stop();
      // 통화가 마이크를 막으면 "녹음은 됐는데 소리가 없는" 모양이 된다 — 원인과 대안을 알려 준다.
      if (r.silent) { setErrKey("voiceRes.err.silent"); setPhase("idle"); return; }
      if (r.seconds < MIN_SECONDS) { setErrKey("voiceRes.err.tooShort"); setPhase("idle"); return; }
      const draft = await requestVoiceDraft(r.wav);
      showToast(t("voiceRes.result.toast", lang), "success");
      onDraft(draft);
      close();
    } catch (e) {
      setErrKey(errorKey(e));
      setPhase("idle");
    }
  };

  finishRef.current = finish;

  const grant = async () => {
    setGrantBusy(true);
    try {
      await onGrantConsent();
      showToast(t("voiceRes.consent.saved", lang), "success");
    } catch {
      showToast(t("voiceRes.consent.fail", lang), "error");
    } finally {
      setGrantBusy(false);
    }
  };

  const withdraw = async () => {
    if (!confirm(t("voiceRes.consent.withdrawConfirm", lang))) return;
    try {
      await onWithdrawConsent();
      showToast(t("voiceRes.consent.withdrawn", lang), "info");
      close();
    } catch {
      showToast(t("voiceRes.consent.fail", lang), "error");
    }
  };

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(t("voiceRes.notice.script", lang));
      showToast(t("voiceRes.notice.copied", lang), "success");
    } catch {
      // 클립보드가 막힌 환경 — 문구가 화면에 보이므로 읽어서 말하면 된다.
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={phase === "idle" ? close : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("voiceRes.title", lang)}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-6 pb-[max(env(safe-area-inset-bottom),24px)] sm:pb-6 max-h-[88vh] overflow-y-auto"
      >
        <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-5" />
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)] inline-flex items-center gap-2">
            <Mic className="w-5 h-5" />
            {t("voiceRes.title", lang)}
          </h2>
          <button onClick={close} aria-label={t("voiceRes.btn.close", lang)} className="w-9 h-9 rounded-full bg-[var(--color-ink-50)] inline-flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── 동의 전 ─────────────────────────────────────── */}
        {!consented && (
          <div className="mt-3 space-y-4">
            {canGrantConsent ? (
              <>
                <p className="text-[13.5px] text-[var(--color-ink-600)] leading-relaxed">{t("voiceRes.consent.lead", lang)}</p>
                <AgreeRow term={TERMS.voice} checked={agreed} onToggle={() => setAgreed((v) => !v)} onView={() => setViewingTerm(true)} />
                <Button block onClick={grant} disabled={!agreed} loading={grantBusy}>
                  {t("voiceRes.consent.btn", lang)}
                </Button>
              </>
            ) : (
              <p className="text-[13.5px] text-[var(--color-ink-600)] leading-relaxed flex gap-2">
                <ShieldCheck className="w-5 h-5 shrink-0 text-[var(--color-navy-700)]" />
                {t("voiceRes.consent.staff", lang)}
              </p>
            )}
          </div>
        )}

        {/* ── 동의 후 ─────────────────────────────────────── */}
        {consented && (
          <>
            {phase === "idle" && (
              <div className="mt-3 space-y-4">
                <p className="text-[13.5px] text-[var(--color-ink-600)] leading-relaxed">{t("voiceRes.intro", lang)}</p>

                <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--color-navy-50)] rounded-[14px]" role="tablist">
                  {(["speaker", "after"] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={mode === m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "h-11 rounded-[10px] text-[12.5px] font-bold",
                        mode === m ? "bg-[var(--color-navy-700)] text-white" : "text-[var(--color-ink-500)]"
                      )}
                    >
                      {t(m === "speaker" ? "voiceRes.mode.speaker" : "voiceRes.mode.after", lang)}
                    </button>
                  ))}
                </div>
                <p className="text-[13px] text-[var(--color-ink-700)] leading-relaxed">
                  {t(mode === "speaker" ? "voiceRes.mode.speaker.desc" : "voiceRes.mode.after.desc", lang)}
                </p>

                {/* 상대방 고지 — 통화 중 모드에서만. 상대 목소리가 처리되기 때문이다. */}
                {mode === "speaker" && (
                  <div className="rounded-[14px] border border-[var(--color-line)] bg-[var(--color-ink-50)] p-3.5">
                    <p className="text-[12px] font-extrabold text-[var(--color-ink-600)] mb-1.5">{t("voiceRes.notice.title", lang)}</p>
                    <p className="text-[14px] font-bold text-[var(--color-navy-900)] leading-relaxed">“{t("voiceRes.notice.script", lang)}”</p>
                    <button onClick={copyScript} className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--color-navy-700)]">
                      <Copy className="w-3.5 h-3.5" />
                      {t("voiceRes.notice.copy", lang)}
                    </button>
                  </div>
                )}

                {errKey && (
                  <p role="alert" className="text-[13px] font-semibold text-[var(--color-danger)] leading-relaxed">
                    {t(errKey, lang)}
                  </p>
                )}

                <Button block onClick={start} loading={starting}>
                  <Mic className="w-4 h-4 mr-1.5" />
                  {t("voiceRes.btn.start", lang)}
                </Button>
                <p className="text-[12px] text-[var(--color-ink-500)] text-center">{t("voiceRes.hint.confirm", lang)}</p>

                {canGrantConsent && (
                  <button onClick={withdraw} className="block mx-auto text-[12px] font-semibold text-[var(--color-ink-400)] underline">
                    {t("voiceRes.consent.withdraw", lang)}
                  </button>
                )}
              </div>
            )}

            {phase === "recording" && (
              <div className="mt-6 space-y-5 text-center" aria-live="polite">
                <div className="mx-auto w-20 h-20 rounded-full bg-[#fef2f2] text-[var(--color-danger)] inline-flex items-center justify-center animate-pulse">
                  <Mic className="w-9 h-9" />
                </div>
                <p className="text-[16px] font-extrabold tabular-nums">{t("voiceRes.recording", lang, { sec: Math.floor(elapsed) })}</p>
                <div className="h-2 rounded-full bg-[var(--color-ink-100)] overflow-hidden" aria-hidden>
                  <div className="h-full bg-[var(--color-navy-700)] transition-[width] duration-150" style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
                </div>
                <p className="text-[12px] text-[var(--color-ink-500)]">{Math.floor(elapsed)} / {MAX_SECONDS}s</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => { cancelRecording(); setPhase("idle"); setLevel(0); }}>
                    {t("voiceRes.btn.cancel", lang)}
                  </Button>
                  <Button onClick={() => void finish()}>
                    <Square className="w-4 h-4 mr-1.5" />
                    {t("voiceRes.btn.stop", lang)}
                  </Button>
                </div>
              </div>
            )}

            {phase === "analyzing" && (
              <div className="mt-8 mb-4 text-center space-y-3" aria-live="polite">
                <Loader2 className="w-8 h-8 mx-auto animate-spin text-[var(--color-navy-700)]" />
                <p className="text-[14px] font-bold">{t("voiceRes.analyzing", lang)}</p>
              </div>
            )}
          </>
        )}
      </div>
      {viewingTerm && <TermsModal term={TERMS.voice} onClose={() => setViewingTerm(false)} />}
    </div>
  );
}

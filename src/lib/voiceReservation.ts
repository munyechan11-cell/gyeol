/**
 * 통화 음성 → 예약 초안 API 호출.
 *
 * 서버(`/api/reservation/voice-draft`)는 **초안**만 돌려준다. 저장은 사장님이 예약 모달에서 한다.
 * 서버는 토큰에서 매장을 읽으므로 본문에 storeId 를 보내지 않는다.
 */
import { api, authHeaders } from "./api";
import { localTodayStr } from "./date";
import { toBase64 } from "./wavRecorder";

export type VoiceField = "date" | "time" | "partySize" | "customerName" | "customerPhone";

/** server/lib/voiceDraft.ts 의 VoiceDraft 와 같은 모양. */
export interface VoiceDraft {
  date?: string;
  time?: string;
  partySize?: number;
  customerName?: string;
  customerPhone?: string;
  memo?: string;
  transcript: string;
  uncertain: VoiceField[];
}

export type VoiceErrorCode =
  | "disabled" // 서버에서 기능이 꺼져 있음(운영자가 유료 키 확인 전)
  | "consent" // 사장님 동의 없음
  | "rate" // 호출 제한
  | "unauthorized"
  | "network"
  | "failed";

export class VoiceDraftError extends Error {
  constructor(public code: VoiceErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VoiceDraftError";
  }
}

const TIMEOUT_MS = 45_000;

export function codeFromStatus(status: number, error?: string): VoiceErrorCode {
  if (status === 503 && error === "VOICE_DRAFT_DISABLED") return "disabled";
  if (status === 403 && error === "consent_required") return "consent";
  if (status === 429) return "rate";
  if (status === 401) return "unauthorized";
  return "failed";
}

export async function requestVoiceDraft(wav: ArrayBuffer): Promise<VoiceDraft> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(api("/api/reservation/voice-draft"), {
      method: "POST",
      headers: await authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ audioBase64: toBase64(wav), mimeType: "audio/wav", today: localTodayStr() }),
      signal: ctrl.signal,
    });
  } catch {
    throw new VoiceDraftError("network");
  } finally {
    clearTimeout(timer);
  }

  let body: { ok?: boolean; draft?: VoiceDraft; error?: string } = {};
  try {
    body = await res.json();
  } catch {
    // JSON 이 아닌 응답(프록시 오류 페이지 등)은 아래에서 failed 로 처리한다.
  }
  if (!res.ok || !body.draft) throw new VoiceDraftError(codeFromStatus(res.status, body.error), body.error);
  return body.draft;
}

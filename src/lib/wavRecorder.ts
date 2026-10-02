/**
 * 마이크 → 16kHz 모노 WAV.
 *
 * 왜 MediaRecorder 를 안 쓰나: 아이폰 Safari 는 mp4(AAC), 갤럭시 Chrome 은 webm(opus)을
 * 내놓는다. 서버가 받는 형식을 하나로 고정하려고 PCM 을 직접 받아 WAV 로 인코딩한다.
 * (Gemini 가 문서로 보증하는 형식이 audio/wav 다.)
 *
 * ⚠️ 통화 중에는 OS 가 마이크를 통화에 우선 배정할 수 있다. 그때 getUserMedia 가 실패하거나
 *    (busy), 성공해도 트랙이 muted 이거나 무음만 들어온다. 이 파일은 그 세 경우를
 *    구분해 돌려준다 — 사용자에게 "다른 방법"을 안내하려면 원인을 알아야 하기 때문이다.
 *    실기기에서 어떻게 동작하는지는 OS·기종마다 다를 수 있다 [미검증].
 */

export const TARGET_RATE = 16000;
export const MAX_SECONDS = 90;
/** 이 값 미만의 최대 진폭이면 사실상 무음으로 본다(−40dBFS). */
export const SILENCE_PEAK = 0.01;
/** 입력 레벨 콜백 최소 간격. */
export const LEVEL_INTERVAL_MS = 100;

export type RecordErrorCode = 'unsupported' | 'permission' | 'no-mic' | 'busy' | 'unknown';

export class RecordError extends Error {
  constructor(public code: RecordErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RecordError';
  }
}

export interface RecordingResult {
  wav: ArrayBuffer;
  seconds: number;
  peak: number;
  rms: number;
  /** 녹음 중 마이크 트랙이 OS 에 의해 muted 로 바뀐 적이 있는가 (통화 점유 신호). */
  trackMuted: boolean;
  /** 거의 무음인가. trackMuted 와 함께 "마이크가 막혔을 수 있다"는 근거. */
  silent: boolean;
}

export interface Recording {
  stop(): Promise<RecordingResult>;
  cancel(): void;
}

// ── 순수 함수 (DOM 없이 테스트 가능) ────────────────────────────

/** 상자 평균으로 낮은 샘플레이트로 줄인다. 평균 없이 솎아내면 고음이 접혀 들어와 음성 인식이 나빠진다. */
export function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (!(inRate > 0) || !(outRate > 0)) throw new Error('invalid sample rate');
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function encodeWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt 청크 크기
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44, pcm.length).set(pcm);
  return buf;
}

export function measureLevel(samples: Float32Array): { peak: number; rms: number } {
  if (samples.length === 0) return { peak: 0, rms: 0 };
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sumSq += samples[i] * samples[i];
  }
  return { peak, rms: Math.sqrt(sumSq / samples.length) };
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** ArrayBuffer → base64. btoa 에 한꺼번에 넘기면 큰 버퍼에서 스택이 터지므로 조각내어 만든다. */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

// ── 브라우저 구현 ───────────────────────────────────────────────

const WORKLET_SRC = `
class GyeolCap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('gyeol-cap', GyeolCap);
`;

export function isRecordingSupported(): boolean {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  const w = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return !!(w.AudioContext || w.webkitAudioContext);
}

/**
 * 녹음을 시작한다. **반드시 버튼 클릭 같은 사용자 동작 안에서 호출**할 것 —
 * 아이폰 Safari 는 그 안에서 만든 AudioContext 만 소리를 받는다.
 */
export async function startRecording(opts: { onLevel?: (rms: number) => void; onAutoStop?: () => void } = {}): Promise<Recording> {
  if (!isRecordingSupported()) throw new RecordError('unsupported');

  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = (w.AudioContext ?? w.webkitAudioContext)!;
  // 컨텍스트를 사용자 동작 안에서 먼저 만들고 깨운다(마이크 허용 창을 기다리는 동안 동작이 만료되지 않게).
  const ctx = new Ctor();
  void ctx.resume().catch(() => {});

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e: unknown) {
    void ctx.close().catch(() => {});
    const name = (e as { name?: string })?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new RecordError('permission');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new RecordError('no-mic');
    // NotReadableError/AbortError — 다른 앱(통화 포함)이 마이크를 쓰고 있을 때 나온다.
    if (name === 'NotReadableError' || name === 'AbortError') throw new RecordError('busy');
    throw new RecordError('unknown', (e as Error)?.message);
  }

  const chunks: Float32Array[] = [];
  let samplesSeen = 0;
  let trackMuted = false;
  let finished = false;
  let autoTimer: ReturnType<typeof setTimeout> | null = null;

  const track = stream.getAudioTracks()[0];
  if (track) {
    if (track.muted) trackMuted = true;
    track.addEventListener('mute', () => { trackMuted = true; });
  }

  const source = ctx.createMediaStreamSource(stream);
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0; // 마이크 소리가 스피커로 되먹임되지 않게 — 그래프만 돌린다.
  silentSink.connect(ctx.destination);

  // 오디오 워크릿은 128샘플(약 350회/초)마다 조각을 보낸다. 그대로 화면 상태에 연결하면
  // 녹음 내내 리렌더가 폭주하므로, 레벨은 100ms 마다 모아서 한 번만 알린다.
  let lvlSumSq = 0;
  let lvlCount = 0;
  let lvlLastEmit = 0;
  const onChunk = (data: Float32Array) => {
    if (finished) return;
    chunks.push(data);
    samplesSeen += data.length;
    if (opts.onLevel) {
      for (let i = 0; i < data.length; i++) lvlSumSq += data[i] * data[i];
      lvlCount += data.length;
      const now = performance.now();
      if (now - lvlLastEmit >= LEVEL_INTERVAL_MS) {
        opts.onLevel(Math.sqrt(lvlSumSq / lvlCount));
        lvlSumSq = 0;
        lvlCount = 0;
        lvlLastEmit = now;
      }
    }
    if (samplesSeen / ctx.sampleRate >= MAX_SECONDS && !autoTimer) {
      autoTimer = setTimeout(() => opts.onAutoStop?.(), 0);
    }
  };

  let teardown: () => void = () => {};
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(ctx, 'gyeol-cap');
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => onChunk(ev.data);
    source.connect(node);
    node.connect(silentSink);
    teardown = () => { node.port.onmessage = null; node.disconnect(); };
  } catch {
    // AudioWorklet 이 없거나 막힌 환경 — 오래됐지만 모든 브라우저에서 도는 ScriptProcessor 로 대체.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(silentSink);
    teardown = () => { node.onaudioprocess = null; node.disconnect(); };
  }

  const release = () => {
    finished = true;
    if (autoTimer) clearTimeout(autoTimer);
    try { teardown(); } catch { /* 이미 끊김 */ }
    try { source.disconnect(); } catch { /* 이미 끊김 */ }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  return {
    async stop() {
      const inRate = ctx.sampleRate;
      release();
      const all = concatFloat32(chunks);
      const { peak, rms } = measureLevel(all);
      const pcm = floatToPcm16(downsample(all, inRate, TARGET_RATE));
      return {
        wav: encodeWav(pcm, Math.min(inRate, TARGET_RATE)),
        seconds: all.length / inRate,
        peak,
        rms,
        trackMuted,
        silent: peak < SILENCE_PEAK,
      };
    },
    cancel() { release(); },
  };
}

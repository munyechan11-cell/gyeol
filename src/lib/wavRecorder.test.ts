import { describe, expect, it } from 'vitest';

import {
  concatFloat32, downsample, encodeWav, floatToPcm16, measureLevel, SILENCE_PEAK, toBase64,
} from './wavRecorder';

const ascii = (dv: DataView, off: number, n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(dv.getUint8(off + i))).join('');

describe('encodeWav', () => {
  it('RIFF/WAVE 헤더·PCM·모노·16kHz·16bit 를 정확히 적는다', () => {
    const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const buf = encodeWav(pcm, 16000);
    const dv = new DataView(buf);
    expect(ascii(dv, 0, 4)).toBe('RIFF');
    expect(ascii(dv, 8, 4)).toBe('WAVE');
    expect(ascii(dv, 12, 4)).toBe('fmt ');
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(1); // 모노
    expect(dv.getUint32(24, true)).toBe(16000);
    expect(dv.getUint32(28, true)).toBe(32000); // byte rate
    expect(dv.getUint16(34, true)).toBe(16);
    expect(ascii(dv, 36, 4)).toBe('data');
    expect(dv.getUint32(40, true)).toBe(10); // 5샘플 × 2바이트
    expect(dv.getUint32(4, true)).toBe(buf.byteLength - 8); // RIFF 크기
    expect(buf.byteLength).toBe(44 + 10);
    expect(dv.getInt16(44 + 2, true)).toBe(1000);
    expect(dv.getInt16(44 + 8, true)).toBe(-32768);
  });

  it('빈 PCM 도 유효한 44바이트 헤더만 만든다', () => {
    const buf = encodeWav(new Int16Array(0), 16000);
    expect(buf.byteLength).toBe(44);
    expect(new DataView(buf).getUint32(40, true)).toBe(0);
  });
});

describe('downsample', () => {
  it('48kHz → 16kHz 는 길이가 1/3 이고 평균을 낸다', () => {
    const input = new Float32Array([0.3, 0.3, 0.3, 0.6, 0.6, 0.6]);
    const out = downsample(input, 48000, 16000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.3, 5);
    expect(out[1]).toBeCloseTo(0.6, 5);
  });

  it('44.1kHz 처럼 나누어떨어지지 않아도 길이가 비율에 맞는다', () => {
    const out = downsample(new Float32Array(44100), 44100, 16000);
    expect(out.length).toBe(16000);
  });

  it('이미 16kHz 이하면 그대로 돌려준다 · 빈 입력은 빈 출력', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsample(input, 16000, 16000)).toBe(input);
    expect(downsample(input, 8000, 16000)).toBe(input);
    expect(downsample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });

  it('잘못된 샘플레이트는 던진다', () => {
    expect(() => downsample(new Float32Array(4), 0, 16000)).toThrow();
    expect(() => downsample(new Float32Array(4), 48000, NaN)).toThrow();
  });
});

describe('floatToPcm16', () => {
  it('±1 은 끝값으로, 범위를 넘으면 잘라낸다', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe('measureLevel / 무음 판정', () => {
  it('빈 입력은 0', () => {
    expect(measureLevel(new Float32Array(0))).toEqual({ peak: 0, rms: 0 });
  });
  it('통화가 마이크를 막아 0 만 들어오면 SILENCE_PEAK 미만', () => {
    expect(measureLevel(new Float32Array(16000)).peak).toBeLessThan(SILENCE_PEAK);
  });
  it('말소리 수준 진폭은 무음이 아니다', () => {
    const tone = new Float32Array(1600).map((_, i) => 0.2 * Math.sin(i / 5));
    const { peak, rms } = measureLevel(tone);
    expect(peak).toBeGreaterThan(SILENCE_PEAK);
    expect(rms).toBeGreaterThan(0.1);
  });
});

describe('toBase64 / concatFloat32', () => {
  it('큰 버퍼도 스택 오버플로 없이 base64 로 왕복한다', () => {
    const bytes = new Uint8Array(500_000).map((_, i) => i % 251);
    const b64 = toBase64(bytes.buffer);
    const back = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(back.length).toBe(bytes.length);
    expect(back[123_456]).toBe(bytes[123_456]);
  });
  it('빈 버퍼는 빈 문자열', () => {
    expect(toBase64(new ArrayBuffer(0))).toBe('');
  });
  it('조각 이어붙이기', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});

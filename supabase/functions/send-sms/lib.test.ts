import { describe, expect, it } from 'vitest';

import { sign, toDomestic, verifySignature } from './lib.ts';

// 테스트용 훅 시크릿(무작위 32바이트의 base64). 실제 키가 아니다.
const SECRET = 'v1,whsec_' + btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7)));
const BODY = JSON.stringify({ user: { phone: '821012345678' }, sms: { otp: '123456' } });
const NOW = 1_700_000_000_000;

const valid = async (over: Partial<{ id: string; ts: string; body: string; secret: string }> = {}) => {
  const id = over.id ?? 'msg_1';
  const ts = over.ts ?? String(Math.floor(NOW / 1000));
  const body = over.body ?? BODY;
  const sig = await sign(body, id, ts, over.secret ?? SECRET);
  return { headers: { id, timestamp: ts, signature: `v1,${sig}` }, body };
};

describe('toDomestic', () => {
  it('E.164 한국 번호를 국내 표기로 되돌린다', () => {
    expect(toDomestic('821012345678')).toBe('01012345678');
    expect(toDomestic('+82-10-1234-5678')).toBe('01012345678');
  });

  it('이미 국내 표기면 그대로 둔다', () => {
    expect(toDomestic('010-1234-5678')).toBe('01012345678');
  });

  it('빈 값은 빈 문자열 — 호출부가 발송 전에 거른다', () => {
    expect(toDomestic('')).toBe('');
  });
});

describe('verifySignature', () => {
  it('제대로 서명된 요청은 통과한다', async () => {
    const { headers, body } = await valid();
    expect(await verifySignature(headers, body, SECRET, NOW)).toBe(true);
  });

  it('본문이 한 글자라도 바뀌면 거부한다', async () => {
    const { headers } = await valid();
    const tampered = BODY.replace('821012345678', '821099999999');
    expect(await verifySignature(headers, tampered, SECRET, NOW)).toBe(false);
  });

  it('다른 키로 서명한 요청은 거부한다', async () => {
    const other = 'v1,whsec_' + btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    const { headers, body } = await valid({ secret: other });
    expect(await verifySignature(headers, body, SECRET, NOW)).toBe(false);
  });

  it('5분보다 오래된 요청은 서명이 맞아도 거부한다 (재전송 차단)', async () => {
    const old = String(Math.floor(NOW / 1000) - 600);
    const { headers, body } = await valid({ ts: old });
    expect(await verifySignature(headers, body, SECRET, NOW)).toBe(false);
  });

  it('헤더가 하나라도 없으면 거부한다', async () => {
    const { headers, body } = await valid();
    expect(await verifySignature({ ...headers, signature: null }, body, SECRET, NOW)).toBe(false);
    expect(await verifySignature({ ...headers, id: null }, body, SECRET, NOW)).toBe(false);
    expect(await verifySignature({ ...headers, timestamp: null }, body, SECRET, NOW)).toBe(false);
  });

  it('시크릿이 비어 있으면 거부한다 — 미설정을 통과로 오해하지 않는다', async () => {
    const { headers, body } = await valid();
    expect(await verifySignature(headers, body, '', NOW)).toBe(false);
  });

  it('서명이 여러 개면 그중 하나만 맞아도 통과한다 (키 교체 중)', async () => {
    const { headers, body } = await valid();
    const multi = { ...headers, signature: `v1,bogussignature ${headers.signature}` };
    expect(await verifySignature(multi, body, SECRET, NOW)).toBe(true);
  });
});

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import reservationRoutes from './reservation.js';

/**
 * /api/reservation/voice-draft 의 관문 테스트.
 * 실제 Supabase·Gemini 없이 확인할 수 있는 것만: 꺼짐 스위치, 인증, 그리고 "꺼져 있으면 인증보다 먼저 막는다".
 * 동의·크기·형식·모델 호출 경로는 voiceDraft.test.ts(순수 로직)와 실환경 시험에서 본다 [미검증: 실제 Gemini 호출].
 */
describe('POST /api/reservation/voice-draft', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(reservationRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => { delete process.env.VOICE_DRAFT_ENABLED; });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/reservation/voice-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('기본값(꺼짐)이면 503 VOICE_DRAFT_DISABLED — 인증 없이도 같은 응답이라 존재 여부만 드러난다', async () => {
    const r = await post({});
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'VOICE_DRAFT_DISABLED' });
  });

  it('"true" 가 아닌 값(1, TRUE, yes)은 켜짐으로 치지 않는다', async () => {
    for (const v of ['1', 'TRUE', 'yes', '']) {
      process.env.VOICE_DRAFT_ENABLED = v;
      expect((await post({})).status).toBe(503);
    }
  });

  it('켜져 있어도 토큰이 없으면 401', async () => {
    process.env.VOICE_DRAFT_ENABLED = 'true';
    const r = await post({ audioBase64: 'AAAA', mimeType: 'audio/wav' });
    expect(r.status).toBe(401);
  });

  it('켜져 있어도 잘못된 토큰은 401', async () => {
    process.env.VOICE_DRAFT_ENABLED = 'true';
    const r = await post({ audioBase64: 'AAAA', mimeType: 'audio/wav' }, { authorization: 'Bearer not-a-real-token' });
    expect(r.status).toBe(401);
  });
});

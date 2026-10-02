import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_MAX_BYTES } from '../lib/voiceDraft.js';

/**
 * 라우트의 연결 로직: 동의 확인 · 크기/형식 제한 · 모델 호출 실패 · 호출 제한 · 로그에 내용이 안 남는가.
 * DB·인증·Gemini 는 모의한다. 모의로 확인되는 것은 "우리 코드가 올바른 순서로 올바르게 부르는가"까지이고,
 * 실제 Gemini 가 이 WAV 를 알아듣는지는 키가 있는 환경에서 따로 봐야 한다 [미검증].
 */

type Caller = { userId: string; storeId: string; role: string } | null;
let caller: Caller = { userId: 'u1', storeId: 'S', role: 'owner' };
let storeDoc: { exists: boolean; data: () => any } = { exists: true, data: () => ({ voiceCallConsentAt: '2026-10-02T00:00:00Z' }) };
const docGet = vi.fn(async () => storeDoc);

vi.mock('../lib/storeAuth.js', async (orig) => {
  const real = await orig<typeof import('../lib/storeAuth.js')>();
  return {
    ...real,
    requireStore: vi.fn(async (_req: unknown, res: any) => {
      if (!caller) { res.status(401).json({ error: 'unauthorized' }); return null; }
      return caller;
    }),
  };
});
vi.mock('../lib/db.js', () => ({
  getDb: () => ({ collection: () => ({ doc: () => ({ get: docGet }) }) }),
  getSupabaseAdmin: () => null,
}));

const realFetch = globalThis.fetch;
let geminiCalls: Array<{ url: string; headers: any; body: any }> = [];
let geminiReply: () => Response = () => new Response('{}', { status: 500 });

const geminiOk = (text: string) => () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

const GOOD_JSON = JSON.stringify({
  date: '2026-10-03', time: '19:00', partySize: 4, customerName: '김철수', customerPhone: '010-1234-5678',
  memo: null, transcript: '내일 저녁 7시 네 명 김철수 공일공 일이삼사', uncertain: ['customerPhone'],
});

const wavBytes = (n: number): Buffer => {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0, 'ascii');
  b.write('WAVE', 8, 'ascii');
  return b;
};

describe('POST /api/reservation/voice-draft — 연결 로직', () => {
  let server: Server;
  let base = '';
  let storeCounter = 0;

  beforeAll(async () => {
    const { default: routes } = await import('./reservation.js');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(routes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    process.env.VOICE_DRAFT_ENABLED = 'true';
    process.env.GEMINI_API_KEY = 'test-key';
    // 테스트마다 다른 매장 id — 매장별 호출 제한 버킷이 테스트끼리 섞이지 않게.
    caller = { userId: 'u1', storeId: `S${++storeCounter}`, role: 'owner' };
    storeDoc = { exists: true, data: () => ({ voiceCallConsentAt: '2026-10-02T00:00:00Z' }) };
    docGet.mockClear();
    // 라우트가 남기는 진행 로그로 테스트 출력이 묻히지 않게. (로그 내용 검증 테스트는 자기 스파이를 따로 건다.)
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    geminiCalls = [];
    geminiReply = geminiOk(GOOD_JSON);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiCalls.push({ url, headers: init?.headers, body: JSON.parse(init?.body ?? '{}') });
        return geminiReply();
      }
      return realFetch(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VOICE_DRAFT_ENABLED;
    delete process.env.GEMINI_API_KEY;
  });

  const post = (body: unknown) =>
    realFetch(`${base}/api/reservation/voice-draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  const audio = (n = 4096) => ({ audioBase64: wavBytes(n).toString('base64'), mimeType: 'audio/wav', today: '2026-10-02' });

  it('정상: 초안을 돌려주고, 모델에는 WAV·오늘 날짜·키가 간다', async () => {
    const r = await post(audio());
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.ok).toBe(true);
    expect(j.draft).toMatchObject({ date: '2026-10-03', time: '19:00', partySize: 4, customerName: '김철수', customerPhone: '01012345678', uncertain: ['customerPhone'] });

    expect(geminiCalls).toHaveLength(1);
    const g = geminiCalls[0];
    expect(g.headers['x-goog-api-key']).toBe('test-key');
    const part = g.body.contents[0].parts[0].inlineData;
    expect(part.mimeType).toBe('audio/wav');
    expect(Buffer.from(part.data, 'base64').equals(wavBytes(4096))).toBe(true);
    expect(g.body.systemInstruction.parts[0].text).toContain('2026-10-02');
  });

  it('승인된 직원이 불러도 동의는 "매장" 기준으로 확인한다 — 읽는 문서는 직원이 아니라 storeId', async () => {
    caller = { userId: 'staff1', storeId: 'STAFFSTORE', role: 'staff' };
    const r = await post(audio());
    expect(r.status).toBe(200);
    expect(docGet).toHaveBeenCalledTimes(1);
  });

  it('동의가 없으면 403 consent_required 이고 모델은 부르지 않는다', async () => {
    storeDoc = { exists: true, data: () => ({}) };
    const r = await post(audio());
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'consent_required' });
    expect(geminiCalls).toHaveLength(0);
  });

  it('동의가 철회된 값(null)도 동의 없음', async () => {
    storeDoc = { exists: true, data: () => ({ voiceCallConsentAt: null }) };
    expect((await post(audio())).status).toBe(403);
  });

  it('매장 문서가 없으면 404', async () => {
    storeDoc = { exists: false, data: () => undefined };
    expect((await post(audio())).status).toBe(404);
    expect(geminiCalls).toHaveLength(0);
  });

  it('인증 실패는 401 이고 DB 도 모델도 건드리지 않는다', async () => {
    caller = null;
    expect((await post(audio())).status).toBe(401);
    expect(docGet).not.toHaveBeenCalled();
    expect(geminiCalls).toHaveLength(0);
  });

  describe('입력 검사 — 전부 모델 호출 전에 거른다', () => {
    it('mimeType 이 audio/wav 가 아니면 400', async () => {
      expect((await post({ ...audio(), mimeType: 'audio/webm' })).status).toBe(400);
    });
    it('audioBase64 가 없거나 문자열이 아니면 400', async () => {
      expect((await post({ mimeType: 'audio/wav' })).status).toBe(400);
      expect((await post({ audioBase64: 123, mimeType: 'audio/wav' })).status).toBe(400);
    });
    it('너무 짧으면(헤더만) 400', async () => {
      expect((await post(audio(44))).status).toBe(400);
    });
    it('WAV 가 아니면 400', async () => {
      const r = await post({ audioBase64: Buffer.alloc(4096, 1).toString('base64'), mimeType: 'audio/wav' });
      expect(r.status).toBe(400);
    });
    it('한도(4MB)를 넘으면 413', async () => {
      expect((await post(audio(VOICE_MAX_BYTES + 1))).status).toBe(413);
    });
    it('한도 정확히는 통과', async () => {
      expect((await post(audio(VOICE_MAX_BYTES))).status).toBe(200);
    });
    afterEach(() => expect(geminiCalls.length).toBeLessThanOrEqual(1));
  });

  describe('모델 쪽 실패', () => {
    it('Gemini 가 5xx/4xx 면 502 transcribe_failed', async () => {
      geminiReply = () => new Response('boom', { status: 503 });
      const r = await post(audio());
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: 'transcribe_failed' });
    });
    it('Gemini 가 빈 응답이면 502', async () => {
      geminiReply = () => new Response(JSON.stringify({ candidates: [] }), { status: 200 });
      expect((await post(audio())).status).toBe(502);
    });
    it('JSON 이 아닌 응답이면 502 parse_failed', async () => {
      geminiReply = geminiOk('죄송해요 못 알아들었어요');
      const r = await post(audio());
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: 'parse_failed' });
    });
    it('GEMINI_API_KEY 가 없으면 503 AI_NOT_CONFIGURED', async () => {
      delete process.env.GEMINI_API_KEY;
      const r = await post(audio());
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'AI_NOT_CONFIGURED' });
    });
  });

  it('매장당 분당 8회를 넘으면 429 — 9번째부터', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post(audio())).status);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
  });

  it('호출 제한은 매장별이다 — 한 매장이 막혀도 다른 매장은 쓴다', async () => {
    for (let i = 0; i < 9; i++) await post(audio());
    caller = { userId: 'u2', storeId: 'ANOTHER', role: 'owner' };
    expect((await post(audio())).status).toBe(200);
  });

  it('서버 로그에 전사·이름·전화번호·음성 바이트가 남지 않는다', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
    await post(audio());
    geminiReply = () => new Response('boom', { status: 503 });
    await post(audio());
    geminiReply = geminiOk('not json');
    await post(audio());
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toMatch(/김철수|01012345678|010-1234|공일공|저녁 7시/);
    expect(logged).not.toContain(wavBytes(4096).toString('base64').slice(0, 40));
    expect(logged).toMatch(/bytes=4096/); // 크기·결과만 남는다
  });
});

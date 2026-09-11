import { afterEach, describe, expect, it, vi } from 'vitest';

import { identityEmail } from './authAdmin.js';
import { isSocialProvider, verifySocialToken } from './socialVerify.js';

/**
 * 소셜 로그인의 안전은 한 가지 성질에 걸려 있다:
 * **신원은 공급자에게서 오고, 클라이언트에게서 오지 않는다.**
 * 그 성질이 조용히 깨지는 걸 여기서 막는다.
 */

const mockFetch = (impl: (url: string, init?: any) => any) => {
  const spy = vi.fn(async (url: any, init?: any) => {
    const body = impl(String(url), init);
    return { ok: body.__status ? body.__status < 400 : true, status: body.__status ?? 200, json: async () => body };
  });
  vi.stubGlobal('fetch', spy);
  return spy;
};

afterEach(() => vi.unstubAllGlobals());

describe('identityEmail', () => {
  it('공급자가 다르면 같은 id 라도 다른 계정이다', () => {
    expect(identityEmail('kakao', '12345')).not.toBe(identityEmail('naver', '12345'));
  });

  it('로컬 파트에 쓸 수 없는 문자를 제거한다', () => {
    // 여기가 뚫리면 id 에 "@" 를 넣어 다른 도메인의 계정을 만들 수 있다.
    expect(identityEmail('kakao', 'a@b.com')).toBe('kakao_abcom@identity.gyeol.app');
  });

  it('제거 후 아무것도 안 남으면 거부한다', () => {
    expect(() => identityEmail('kakao', '@@@')).toThrow();
  });
});

describe('isSocialProvider', () => {
  it('아는 공급자만 통과시킨다', () => {
    expect(isSocialProvider('kakao')).toBe(true);
    expect(isSocialProvider('naver')).toBe(true);
    expect(isSocialProvider('google')).toBe(true);
    expect(isSocialProvider('facebook')).toBe(false);
    expect(isSocialProvider(undefined)).toBe(false);
  });
});

describe('verifySocialToken', () => {
  it('카카오 — 토큰을 Bearer 로 붙여 카카오에 직접 묻는다', async () => {
    const spy = mockFetch(() => ({ id: 777, kakao_account: { email: 'a@b.c', profile: { nickname: '결' } } }));
    const id = await verifySocialToken('kakao', 'TOK');
    expect(spy.mock.calls[0][0]).toContain('kapi.kakao.com');
    expect((spy.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer TOK');
    expect(id).toMatchObject({ provider: 'kakao', id: '777', name: '결', email: 'a@b.c' });
  });

  it('네이버 — resultcode 가 00 이 아니면 거부한다', async () => {
    mockFetch(() => ({ resultcode: '024', message: 'unauthorized' }));
    await expect(verifySocialToken('naver', 'TOK')).rejects.toThrow('unauthorized');
  });

  it('공급자가 4xx 를 주면 신원을 만들어 내지 않는다', async () => {
    mockFetch(() => ({ __status: 401, msg: 'invalid token' }));
    await expect(verifySocialToken('kakao', 'BAD')).rejects.toThrow(/401/);
  });

  it('구글 — GOOGLE_CLIENT_ID 가 설정돼 있으면 토큰의 aud 까지 확인한다', async () => {
    // 이 검사가 없으면 다른 앱에 발급된 구글 토큰을 가져와 로그인할 수 있다.
    process.env.GOOGLE_CLIENT_ID = 'ours.apps.googleusercontent.com';
    mockFetch((url) =>
      url.includes('tokeninfo') ? { aud: 'someone-else.apps.googleusercontent.com' } : { sub: 'g1' }
    );
    await expect(verifySocialToken('google', 'TOK')).rejects.toThrow('audience mismatch');
    delete process.env.GOOGLE_CLIENT_ID;
  });

  it('구글 — aud 가 맞으면 통과', async () => {
    process.env.GOOGLE_CLIENT_ID = 'ours.apps.googleusercontent.com';
    mockFetch((url) =>
      url.includes('tokeninfo')
        ? { aud: 'ours.apps.googleusercontent.com' }
        : { sub: 'g1', name: '결', email: 'a@b.c' }
    );
    await expect(verifySocialToken('google', 'TOK')).resolves.toMatchObject({ id: 'g1' });
    delete process.env.GOOGLE_CLIENT_ID;
  });
});

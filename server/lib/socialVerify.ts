import type { SocialIdentity, SocialProvider } from './authAdmin.js';

/**
 * 소셜 액세스 토큰 → 신원. **공급자에게 직접 물어본다.**
 *
 * 클라이언트가 보낸 `{ provider, id }` 를 그대로 믿으면 안 된다. 그건 아무나
 * 아무 id 나 적어 보낼 수 있다는 뜻이고, 그러면 남의 계정으로 세션이 발급된다.
 * 토큰만 받고, 그 토큰이 누구 것인지는 카카오·네이버·구글에게 묻는다.
 */

const TIMEOUT_MS = 8000;

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`provider ${res.status}: ${body?.msg ?? body?.message ?? body?.error ?? 'failed'}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function isSocialProvider(v: unknown): v is SocialProvider {
  return v === 'kakao' || v === 'naver' || v === 'google';
}

export async function verifySocialToken(
  provider: SocialProvider,
  accessToken: string
): Promise<SocialIdentity> {
  const auth = { Authorization: `Bearer ${accessToken}` };

  if (provider === 'kakao') {
    const u = await getJson('https://kapi.kakao.com/v2/user/me', auth);
    if (!u?.id) throw new Error('kakao: no id');
    const account = u.kakao_account ?? {};
    const profile = account.profile ?? {};
    return {
      provider,
      id: String(u.id),
      name: profile.nickname,
      email: account.email,
      avatarUrl: profile.thumbnail_image_url,
    };
  }

  if (provider === 'naver') {
    const u = await getJson('https://openapi.naver.com/v1/nid/me', auth);
    if (u?.resultcode !== '00' || !u?.response?.id) throw new Error(u?.message ?? 'naver: no id');
    const r = u.response;
    return {
      provider,
      id: String(r.id),
      name: r.name || r.nickname,
      email: r.email,
      avatarUrl: r.profile_image,
    };
  }

  // google — userinfo 는 토큰이 **누구 것인지**만 알려준다. 이 토큰이 우리 앱에
  // 발급된 것인지까지 확인해야 다른 앱의 토큰을 가져다 쓰는 걸 막을 수 있다.
  const info = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', auth);
  if (!info?.sub) throw new Error('google: no sub');
  const expectedAud = process.env.GOOGLE_CLIENT_ID?.trim();
  if (expectedAud) {
    const tokenInfo = await getJson(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      {}
    );
    if (tokenInfo?.aud !== expectedAud) throw new Error('google: audience mismatch');
  }
  return {
    provider,
    id: String(info.sub),
    name: info.name,
    email: info.email,
    avatarUrl: info.picture,
  };
}

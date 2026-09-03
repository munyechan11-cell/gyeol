import { Router } from 'express';

import { mintSocialSession, type SocialProvider } from '../lib/authAdmin.js';
import { getBaseUrl } from '../lib/http.js';
import { isSocialProvider, verifySocialToken } from '../lib/socialVerify.js';

const router = Router();

// ============================================================
// 소셜 로그인 — 카카오·네이버·구글.
//
// **예전과 달라진 점.** 예전에는 여기서 Firebase Custom Token 을 만들어 창으로
// 넘겼다. 지금은 Supabase 의 1회용 세션 토큰(token_hash)을 넘긴다. 클라이언트가
// `verifyOtp({ token_hash, type:'magiclink' })` 로 교환하면 진짜 세션이 생기고,
// 그때서야 login() 이 통과한다.
//
// 두 갈래가 있다. 둘 다 끝은 같다(세션):
//   · 리다이렉트 —  /api/auth/{kakao,naver}/url → 공급자 → /callback → 창 postMessage
//   · SDK       —  클라이언트가 받은 액세스 토큰을 POST /api/auth/social/session 로
//
// 어느 쪽이든 **공급자에게 서버가 직접 확인한 뒤에만** 토큰이 나간다.
// ============================================================

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const BRAND: Record<SocialProvider, string> = {
  kakao: '#4CAF50',
  naver: '#03C75A',
  google: '#4285F4',
};

/**
 * 로그인 창이 부모 창에 결과를 넘기고 스스로 닫는 페이지.
 *
 * 경로가 셋(postMessage · localStorage · 안내 문구)인 이유: 모바일 인앱 브라우저는
 * window.opener 가 없기도 하고 window.close() 가 막혀 있기도 하다. 하나만 두면
 * 그 환경의 사용자는 로그인해 놓고 빈 창을 보게 된다.
 */
function popupResult(payload: Record<string, unknown>, color: string): string {
  return `<!doctype html><html><body><script>
    const tokenData = ${JSON.stringify(payload)};
    tokenData.timestamp = Date.now();
    if (window.opener && !window.opener.closed) window.opener.postMessage(tokenData, '*');
    try { localStorage.setItem('oauth_token_data', JSON.stringify(tokenData)); } catch (e) {}
    window.close();
    setTimeout(() => {
      document.body.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;text-align:center;padding:20px;"><div><h2 style="color:${color};margin-bottom:10px;">로그인 성공!</h2><p style="color:#666;margin-bottom:20px;">원래 화면으로 돌아가주세요.<br>이 창은 닫으셔도 됩니다.</p><button onclick="window.close()" style="padding:10px 20px;background:${color};color:white;border:none;border-radius:5px;font-size:16px;cursor:pointer;">창 닫기</button></div></div>';
    }, 500);
  </script></body></html>`;
}

function popupError(message: string): string {
  const payload = JSON.stringify({ type: 'OAUTH_AUTH_ERROR', error: message });
  return `<!doctype html><html><body>
    <p>Authentication failed: ${escapeHtml(message)}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(${payload}, '*');
        setTimeout(() => window.close(), 2000);
      }
    </script>
  </body></html>`;
}

// ---------- 리다이렉트 방식 ----------

router.get('/api/auth/kakao/url', (_req, res) => {
  const clientId = process.env.KAKAO_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'KAKAO_CLIENT_ID is not set' });
  const redirectUri = `${getBaseUrl()}/api/auth/kakao/callback`;
  res.json({
    url: `https://kauth.kakao.com/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code`,
  });
});

router.get('/api/auth/kakao/callback', async (req, res) => {
  try {
    const clientId = process.env.KAKAO_CLIENT_ID;
    const redirectUri = `${getBaseUrl()}/api/auth/kakao/callback`;
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId || '',
        redirect_uri: redirectUri,
        code: String(req.query.code ?? ''),
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const identity = await verifySocialToken('kakao', tokenData.access_token);
    const { tokenHash } = await mintSocialSession(identity);
    res.send(
      popupResult(
        { type: 'OAUTH_AUTH_SUCCESS', provider: 'kakao', tokenHash, profile: identity },
        BRAND.kakao
      )
    );
  } catch (err: any) {
    console.error('[oauth/kakao]', err?.message ?? err);
    res.status(500).send(popupError(String(err?.message || 'Unknown error')));
  }
});

router.get('/api/auth/naver/url', (_req, res) => {
  const clientId = process.env.NAVER_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'NAVER_CLIENT_ID is not set' });
  const redirectUri = `${getBaseUrl()}/api/auth/naver/callback`;
  const state = Math.random().toString(36).substring(7);
  res.json({
    url: `https://nid.naver.com/oauth2.0/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&state=${state}`,
  });
});

router.get('/api/auth/naver/callback', async (req, res) => {
  try {
    const clientId = process.env.NAVER_CLIENT_ID;
    const clientSecret = process.env.NAVER_CLIENT_SECRET;
    const tokenRes = await fetch(
      `https://nid.naver.com/oauth2.0/token?grant_type=authorization_code&client_id=${clientId}&client_secret=${clientSecret}&code=${encodeURIComponent(String(req.query.code ?? ''))}&state=${encodeURIComponent(String(req.query.state ?? ''))}`
    );
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const identity = await verifySocialToken('naver', tokenData.access_token);
    const { tokenHash } = await mintSocialSession(identity);
    res.send(
      popupResult(
        { type: 'OAUTH_AUTH_SUCCESS', provider: 'naver', tokenHash, profile: identity },
        BRAND.naver
      )
    );
  } catch (err: any) {
    console.error('[oauth/naver]', err?.message ?? err);
    res.status(500).send(popupError(String(err?.message || 'Unknown error')));
  }
});

// ---------- SDK 방식 ----------

/**
 * 클라이언트 SDK 로 이미 로그인한 사용자의 액세스 토큰을 세션으로 바꾼다.
 * 카카오 JS SDK 처럼 앱 안에서 바로 로그인이 끝나는 경우에 쓴다.
 */
router.post('/api/auth/social/session', async (req, res) => {
  try {
    const { provider, accessToken } = req.body ?? {};
    if (!isSocialProvider(provider)) return res.status(400).json({ error: 'unknown provider' });
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).json({ error: 'accessToken required' });
    }
    const identity = await verifySocialToken(provider, accessToken);
    const { tokenHash, userId } = await mintSocialSession(identity);
    res.json({ tokenHash, userId, profile: identity });
  } catch (e: any) {
    console.error('[auth/social/session]', e?.message ?? e);
    // 공급자 거절과 우리 쪽 장애를 구분해 준다 — 401 이면 다시 로그인하면 되고,
    // 500 이면 다시 눌러도 소용없다.
    const denied = /provider 4\d\d|no id|no sub|mismatch/.test(String(e?.message ?? ''));
    res.status(denied ? 401 : 500).json({ error: e?.message ?? 'social session failed' });
  }
});

export default router;

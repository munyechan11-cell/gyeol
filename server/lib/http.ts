


// fetch with timeout — AI API가 영영 안 돌아오는 사고 방지
export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 이 서비스의 공개 주소. OAuth redirect_uri 처럼 "밖에서 우리를 부를 주소"에 쓴다.
 * (오래 firebase.ts 에 있었지만 Firebase 와 아무 관계가 없다.)
 */
export const getBaseUrl = (): string => process.env.APP_URL || 'http://localhost:3000';

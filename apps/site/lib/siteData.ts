// 서버 구현이 아니라 "모양"만 가져온다 — sitePayload.ts 는 firebase-admin 에 의존하므로
// 여기서 참조하면 이 앱의 타입체크가 서버 의존성까지 요구하게 된다.
import type { SitePayload } from "../../../server/lib/siteTypes";

export type { SitePayload };

/**
 * 공개 사이트 데이터 원본.
 *
 * 아직 Express API 를 통해 받는다. Phase 2 에서 API 자체가 이 앱의 Route Handler 로
 * 넘어오면 `buildSitePayload()` 를 직접 호출하도록 바꾼다 — 그때를 위해 서버가
 * 내려주는 필드 선별 로직은 이미 server/lib/sitePayload.ts 로 분리해 두었다.
 */
const API_BASE = (process.env.SITE_API_BASE ?? "http://localhost:3000").replace(/\/+$/, "");

/** 매장 데이터를 가져온다. 없는 매장이면 null (404 로 렌더). */
export async function fetchSite(storeId: string): Promise<SitePayload | null> {
  const res = await fetch(`${API_BASE}/api/site/${encodeURIComponent(storeId)}`, {
    // 매장 정보는 자주 바뀌지 않는다. 5분 캐시로 응답 속도와 API 부하를 함께 줄인다.
    next: { revalidate: 300 },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`site api ${res.status}`);
  return (await res.json()) as SitePayload;
}

/** 이미지 서빙은 매장 경계 검증을 위해 storeId 필수 (타매장 사진 IDOR 차단). */
export const imgUrl = (photoId: string, storeId: string) =>
  `${API_BASE}/api/marketing/image/${encodeURIComponent(photoId)}?storeId=${encodeURIComponent(storeId)}`;

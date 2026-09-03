import type { CompatDb } from './db.js';
import { isValidStoreId } from './storeAuth.js';
import type { SiteMenuItem, SitePayload, SiteReview, SiteStore } from './siteTypes.js';

// ============================================================
// 가게 공개 브랜드 사이트 데이터 (/site/:storeId).
//
// 로그인 없이 누구나 보는 화면이라, "공개해도 되는 필드만" 서버에서 골라 담는다.
// 개인정보 최소화 규칙이 이 파일에 모여 있다 — 리뷰 작성자는 첫 글자만, 손님이 올린
// 사진은 아예 제외, 연락처는 매장 대표번호만.
//
// 모양을 만드는 부분(shape*)은 순수 함수로 떼어 두었다. Firestore 없이 테스트할 수 있고,
// 규칙이 조용히 느슨해지는 걸 sitePayload.test.ts 가 막는다.
// ============================================================

export type { SiteStore, SiteMenuItem, SiteReview, SitePayload } from './siteTypes.js';

export type SiteResult =
  | { ok: true; data: SitePayload }
  | { ok: false; status: 400 | 404; error: string };

/** 판매중인 메뉴만, 최대 60개. */
export function shapeMenu(docs: any[]): SiteMenuItem[] {
  return docs
    .filter((m) => m && m.isAvailable !== false && m.name)
    .slice(0, 60)
    .map((m) => {
      // 메뉴 사진이 인라인 base64 data URL 이면 응답에서 제외 — 공개 JSON 폭증·egress·LCP 방지
      // (갤러리처럼 별도 서빙 전까지 안전장치). http(s) URL 만 통과.
      const raw = typeof m.imageUrl === 'string' ? m.imageUrl : '';
      return {
        name: String(m.name).slice(0, 60),
        price: Number(m.price) || 0,
        category: String(m.category || '').slice(0, 30),
        imageUrl: raw.startsWith('data:') || raw.length > 2048 ? '' : raw,
        description: typeof m.description === 'string' ? m.description.slice(0, 200) : '',
      };
    });
}

/** 최신 리뷰 8개. 작성자 이름은 첫 글자만, 손님 사진은 붙이지 않는다. */
export function shapeReviews(photos: any[]): SiteReview[] {
  return photos
    .filter((p) => p.type === 'review' && typeof p.reviewText === 'string' && p.reviewText.trim())
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 8)
    .map((p) => ({
      rating: Number(p.rating) || 0,
      text: String(p.reviewText).slice(0, 280),
      name: (String(p.customerName || '').trim()[0] || '·') + '님', // 이름 첫 글자만 노출
      date: String(p.createdAt || '').slice(0, 10),
      photoId: null, // 손님 리뷰 사진은 공개 동의 절차 전까지 미노출(얼굴 등 개인정보 가능)
    }));
}

/** 히어로/배경용 갤러리 — 매장이 올린 '메뉴' 사진만. 손님·리뷰 사진은 제외. */
export function shapeGallery(photos: any[]): string[] {
  return photos
    .filter((p) => p.type === 'menu' && typeof p.imageData === 'string')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 8)
    .map((p) => p.id);
}

export function shapeStore(owner: any): SiteStore {
  const cfg = owner?.storeConfig ?? {};
  const ch = cfg?.publishing?.channels ?? {};
  return {
    name: String(owner?.restaurantName || '우리 가게').slice(0, 60),
    fontTheme: typeof cfg?.fontTheme === 'string' ? cfg.fontTheme : '',
    tagline: typeof cfg?.tagline === 'string' ? cfg.tagline.slice(0, 80) : '',
    address: typeof cfg?.address === 'string' ? cfg.address.slice(0, 120) : '',
    // 개인 휴대폰은 노출하지 않음 — AI 예약을 켠 매장의 대표번호만(끄면 비노출).
    phone:
      cfg?.aiReservation?.enabled === true && typeof cfg?.aiReservation?.phoneNumber === 'string'
        ? cfg.aiReservation.phoneNumber
        : '',
    businessHours: owner?.businessHours || null,
    temporarilyClosed: !!owner?.temporarilyClosed,
    instagram: ch.instagram?.username || cfg?.publishing?.instagramUsername || '',
  };
}

/**
 * 공개 사이트 데이터를 읽어 온다.
 *
 * Express 라우트와 (Phase 2 의) Next.js 서버 렌더가 같은 함수를 쓴다 —
 * 공개 필드 선별 규칙이 두 벌로 갈라지면 한쪽만 개인정보를 흘리게 된다.
 *
 * 인자는 Firestore 핸들이 아니라 lib/db.ts 의 CompatDb 다. 읽기 모양이 같아
 * 이 함수의 본문은 Supabase 이전에도 그대로다 — 필드 선별 규칙을 건드리지 않고
 * 저장소만 바꿀 수 있다는 게 이 어댑터를 둔 이유다.
 */
export async function buildSitePayload(
  fs: CompatDb,
  storeId: string
): Promise<SiteResult> {
  if (!isValidStoreId(storeId)) return { ok: false, status: 400, error: 'bad storeId' };

  const ownerSnap = await fs.collection('users').doc(storeId).get();
  if (!ownerSnap.exists) return { ok: false, status: 404, error: 'store not found' };
  const owner = ownerSnap.data() as any;
  if (owner?.role !== 'owner') return { ok: false, status: 404, error: 'not a store' }; // 명시적 owner만(fail-closed)

  const menuSnap = await fs.collection('menus').where('storeId', '==', storeId).limit(150).get();
  const photoSnap = await fs.collection('photos').where('storeId', '==', storeId).limit(400).get();
  const photos = photoSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  return {
    ok: true,
    data: {
      store: shapeStore(owner),
      menu: shapeMenu(menuSnap.docs.map((d) => d.data() as any)),
      reviews: shapeReviews(photos),
      gallery: shapeGallery(photos),
    },
  };
}

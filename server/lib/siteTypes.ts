// ============================================================
// 공개 매장 사이트가 주고받는 데이터 모양.
//
// **이 파일은 아무것도 import 하지 않는다.** Express 서버와 Next 앱(apps/site)이
// 같은 타입을 공유해야 하는데, 서버 구현을 끌어오면 Next 앱 쪽 타입체크가
// 서버 의존성(@supabase/supabase-js 등)까지 요구하게 된다. 모양과 구현을 분리해 둔다.
// ============================================================

export interface SiteStore {
  name: string;
  fontTheme: string;
  tagline: string;
  address: string;
  phone: string;
  businessHours: { weekly?: Array<{ open?: string; close?: string; closed?: boolean }>; open24h?: boolean } | null;
  temporarilyClosed: boolean;
  instagram: string;
}

export interface SiteMenuItem {
  name: string;
  price: number;
  category: string;
  imageUrl: string;
  description: string;
}

export interface SiteReview {
  rating: number;
  text: string;
  name: string;
  date: string;
  /** 손님 사진은 공개 동의 절차 전까지 항상 null. shapeReviews 참고. */
  photoId: string | null;
}

export interface SitePayload {
  store: SiteStore;
  menu: SiteMenuItem[];
  reviews: SiteReview[];
  gallery: string[];
}

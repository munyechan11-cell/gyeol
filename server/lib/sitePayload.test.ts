import { describe, expect, it } from 'vitest';

import { shapeGallery, shapeMenu, shapeReviews, shapeStore } from './sitePayload.js';

/**
 * 공개 사이트 페이로드 — 로그인 없이 누구나 보는 데이터라 개인정보 규칙이 곧 보안 경계다.
 * 규칙이 조용히 느슨해지면 손님 이름·얼굴이 공개 URL 로 새어 나간다.
 */
describe('shapeStore', () => {
  it('[보안] AI 예약이 꺼져 있으면 대표번호를 노출하지 않는다', () => {
    const owner = {
      restaurantName: '결식당',
      storeConfig: { aiReservation: { enabled: false, phoneNumber: '0212345678' } },
    };
    expect(shapeStore(owner).phone).toBe('');
  });

  it('[보안] enabled 가 true 가 아닌 값(문자열 "true" 등)이면 노출하지 않는다', () => {
    const owner = {
      storeConfig: { aiReservation: { enabled: 'true', phoneNumber: '0212345678' } },
    };
    expect(shapeStore(owner).phone).toBe('');
  });

  it('AI 예약이 켜져 있으면 대표번호를 노출한다', () => {
    const owner = {
      storeConfig: { aiReservation: { enabled: true, phoneNumber: '0212345678' } },
    };
    expect(shapeStore(owner).phone).toBe('0212345678');
  });

  it('매장명이 없으면 기본값으로 대체하고, 지나치게 길면 자른다', () => {
    expect(shapeStore({}).name).toBe('우리 가게');
    expect(shapeStore({ restaurantName: '가'.repeat(200) }).name).toHaveLength(60);
  });

  it('인스타그램 계정은 channels 우선, 없으면 레거시 필드로 폴백한다', () => {
    const withChannel = { storeConfig: { publishing: { channels: { instagram: { username: 'new' } }, instagramUsername: 'old' } } };
    const legacyOnly = { storeConfig: { publishing: { instagramUsername: 'old' } } };
    expect(shapeStore(withChannel).instagram).toBe('new');
    expect(shapeStore(legacyOnly).instagram).toBe('old');
    expect(shapeStore({}).instagram).toBe('');
  });
});

describe('shapeMenu', () => {
  it('[보안] base64 data URL 사진은 응답에서 제거한다 — 공개 JSON 폭증·LCP 방지', () => {
    const out = shapeMenu([{ name: '김치찌개', price: 9000, imageUrl: 'data:image/png;base64,AAAA' }]);
    expect(out[0].imageUrl).toBe('');
  });

  it('2048자를 넘는 URL 도 제거한다', () => {
    const out = shapeMenu([{ name: '메뉴', imageUrl: 'https://x.test/' + 'a'.repeat(2100) }]);
    expect(out[0].imageUrl).toBe('');
  });

  it('일반 http(s) URL 은 통과시킨다', () => {
    const out = shapeMenu([{ name: '메뉴', imageUrl: 'https://cdn.test/a.jpg' }]);
    expect(out[0].imageUrl).toBe('https://cdn.test/a.jpg');
  });

  it('판매 중지(isAvailable=false)와 이름 없는 항목은 제외한다', () => {
    const out = shapeMenu([
      { name: '판매중' },
      { name: '중지', isAvailable: false },
      { price: 1000 },
      null,
    ]);
    expect(out.map((m) => m.name)).toEqual(['판매중']);
  });

  it('isAvailable 이 없으면 판매중으로 본다 — 레거시 문서 호환', () => {
    expect(shapeMenu([{ name: '옛날메뉴' }])).toHaveLength(1);
  });

  it('최대 60개까지만 담는다', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `m${i}` }));
    expect(shapeMenu(many)).toHaveLength(60);
  });

  it('가격이 숫자가 아니면 0 으로 정규화한다', () => {
    expect(shapeMenu([{ name: 'x', price: '' }])[0].price).toBe(0);
    expect(shapeMenu([{ name: 'x', price: '9000' }])[0].price).toBe(9000);
  });
});

describe('shapeReviews', () => {
  const review = (over: Record<string, unknown> = {}) => ({
    type: 'review', reviewText: '맛있어요', customerName: '홍길동',
    rating: 5, createdAt: '2026-08-01T10:00:00Z', ...over,
  });

  it('[보안] 작성자 이름은 첫 글자만 노출한다', () => {
    expect(shapeReviews([review()])[0].name).toBe('홍님');
  });

  it('[보안] 이름이 비어 있으면 가운뎃점으로 대체한다 — 빈 이름 노출 방지', () => {
    expect(shapeReviews([review({ customerName: '   ' })])[0].name).toBe('·님');
    expect(shapeReviews([review({ customerName: undefined })])[0].name).toBe('·님');
  });

  it('[보안] 손님 리뷰 사진은 절대 붙이지 않는다', () => {
    const out = shapeReviews([review({ photoId: 'p1', imageData: 'data:image/png;base64,AAA' })]);
    expect(out[0].photoId).toBe(null);
    expect(Object.keys(out[0]).sort()).toEqual(['date', 'name', 'photoId', 'rating', 'text']);
  });

  it('리뷰가 아닌 사진과 본문이 빈 리뷰는 제외한다', () => {
    const out = shapeReviews([
      review({ reviewText: '진짜 리뷰' }),
      review({ reviewText: '   ' }),
      { type: 'menu', reviewText: '메뉴사진' },
    ]);
    expect(out.map((r) => r.text)).toEqual(['진짜 리뷰']);
  });

  it('최신순 8개까지만 담는다', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      review({ reviewText: `r${i}`, createdAt: `2026-08-${String(i + 1).padStart(2, '0')}` })
    );
    const out = shapeReviews(many);
    expect(out).toHaveLength(8);
    expect(out[0].text).toBe('r19'); // 가장 최근
  });

  it('본문은 280자로 자른다', () => {
    expect(shapeReviews([review({ reviewText: '가'.repeat(500) })])[0].text).toHaveLength(280);
  });
});

describe('shapeGallery', () => {
  it("[보안] 매장이 올린 'menu' 사진만 담는다 — 손님·리뷰 사진 제외", () => {
    const out = shapeGallery([
      { id: 'a', type: 'menu', imageData: 'x', createdAt: '2026-08-02' },
      { id: 'b', type: 'review', imageData: 'x', createdAt: '2026-08-03' },
      { id: 'c', type: 'customer', imageData: 'x', createdAt: '2026-08-04' },
    ]);
    expect(out).toEqual(['a']);
  });

  it('이미지 데이터가 없는 문서는 제외한다', () => {
    expect(shapeGallery([{ id: 'a', type: 'menu' }])).toEqual([]);
  });

  it('최신순 8개까지만 담는다', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`, type: 'menu', imageData: 'x',
      createdAt: `2026-08-${String(i + 1).padStart(2, '0')}`,
    }));
    const out = shapeGallery(many);
    expect(out).toHaveLength(8);
    expect(out[0]).toBe('p19');
  });
});

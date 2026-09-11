import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StoreSite } from "../../../../../components/StoreSite";
import { getSiteFont, googleFontsHref } from "../../../../../lib/fonts";
import { isLang, LANGS, t, type Lang } from "../../../../../lib/i18n";
import { fetchSite } from "../../../../../lib/siteData";

// 매장 정보는 자주 바뀌지 않는다. 5분 ISR — 크롤러와 손님 모두 캐시된 HTML 을 받는다.
// 경로 전체(언어 + 매장)가 캐시 키다.
export const revalidate = 300;

// generateStaticParams 는 두지 않는다.
// 매장 id 를 빌드 타임에 알 수 없으므로 언어만 넘겨 봐야 미리 만들 수 있는 페이지가 없다
// (빌드 산출물에서도 이 라우트는 그대로 동적으로 잡힌다). 요청 시 렌더 + ISR 로 충분하다.

type Params = { lang: string; storeId: string };

const SITE_ORIGIN = (process.env.SITE_PUBLIC_ORIGIN ?? "http://localhost:3200").replace(/\/+$/, "");

/**
 * 검색 노출의 실체가 여기 있다.
 *
 * SPA 시절에는 크롤러가 빈 <div id="root"> 만 보고 갔다. 이제 매장명·소개·대표 사진이
 * HTML 에 박혀 나가고, hreflang 로 4개 언어판이 서로를 가리킨다.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { lang: rawLang, storeId } = await params;
  const lang: Lang = isLang(rawLang) ? rawLang : "ko";
  const data = await fetchSite(storeId).catch(() => null);
  if (!data) return { title: t("site.error.title", lang) };

  const { store } = data;
  const title = `${store.name} · 결`;
  // 소개문이 없으면 메뉴 이름 몇 개로 설명을 만든다 — 빈 description 보다 낫다.
  const description =
    store.tagline ||
    (data.menu.length
      ? `${store.name} — ${data.menu.slice(0, 5).map((m) => m.name).join(", ")}`
      : store.name);

  const path = (l: Lang) => `${SITE_ORIGIN}/${l}/site/${encodeURIComponent(storeId)}`;

  return {
    title,
    description,
    alternates: {
      canonical: path(lang),
      languages: Object.fromEntries(LANGS.map((l) => [l, path(l)])),
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: path(lang),
      siteName: store.name,
      locale: lang,
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

export default async function StoreSitePage({ params }: { params: Promise<Params> }) {
  const { lang: rawLang, storeId } = await params;
  if (!isLang(rawLang)) notFound();
  const lang: Lang = rawLang;

  const data = await fetchSite(storeId);
  if (!data) notFound();

  const font = getSiteFont(data.store.fontTheme);
  const appBaseUrl = (process.env.SITE_APP_ORIGIN ?? "").replace(/\/+$/, "");

  // 구조화 데이터 — 검색 결과에 영업시간·평점이 함께 노출되게 한다.
  const rated = data.reviews.filter((r) => r.rating > 0);
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: data.store.name,
    ...(data.store.address ? { address: data.store.address } : {}),
    ...(data.store.phone ? { telephone: data.store.phone } : {}),
    ...(rated.length
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: (rated.reduce((s, r) => s + r.rating, 0) / rated.length).toFixed(1),
            reviewCount: rated.length,
          },
        }
      : {}),
  };

  return (
    <>
      {/* 선택된 글꼴 프리셋만 로드 — SPA 에서는 useEffect 로 붙이던 것을 서버에서 미리 넣는다. */}
      <link rel="stylesheet" href={googleFontsHref([font.google])} />
      <script
        type="application/ld+json"
        // 값은 서버가 만든 객체를 직렬화한 것이라 사용자 입력이 스크립트로 실행될 여지가 없다.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />
      <StoreSite data={data} storeId={storeId} lang={lang} appBaseUrl={appBaseUrl} />
    </>
  );
}

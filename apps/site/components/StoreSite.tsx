import { fmtKRW, getLocale, t, type Lang } from "../lib/i18n";
import { getSiteFont } from "../lib/fonts";
import { imgUrl, type SitePayload } from "../lib/siteData";

/**
 * 공개 매장 사이트 — 서버 컴포넌트.
 *
 * SPA(src/pages/StoreSite.tsx)의 화면을 그대로 옮긴 것이다. 다른 점은 셋뿐:
 *  1. 데이터를 useEffect 가 아니라 서버에서 미리 받아 HTML 에 박아 보낸다(= 검색 노출)
 *  2. 언어를 localStorage 가 아니라 URL 세그먼트에서 받는다
 *  3. 앱 내부 링크(주문하기)는 라우터가 다르므로 일반 <a> 로 나간다
 * 색·여백·글꼴 프리셋은 이행 중 두 화면이 달라 보이지 않도록 값까지 동일하게 유지한다.
 */

/** 요일 라벨 — weekly[0]=일요일 (2024-01-07 이 일요일이라 +i 로 요일 생성) */
const weekdayLabel = (i: number, lang: Lang) =>
  new Date(2024, 0, 7 + i).toLocaleDateString(getLocale(lang), { weekday: "short" });

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="text-center">
      <p className="text-[11px] tracking-[0.3em] uppercase text-[#b08e63] font-bold mb-3">{eyebrow}</p>
      <h2
        className="text-[30px] sm:text-[40px] text-[#2b2622] tracking-tight"
        style={{ fontFamily: "var(--site-display)" }}
      >
        {title}
      </h2>
    </div>
  );
}

export function StoreSite({
  data,
  storeId,
  lang,
  appBaseUrl,
}: {
  data: SitePayload;
  storeId: string;
  lang: Lang;
  appBaseUrl: string;
}) {
  const { store, menu, reviews, gallery } = data;
  const siteFont = getSiteFont(store.fontTheme);
  const hero = gallery[0];
  const orderHref = `${appBaseUrl}/customer/store/${encodeURIComponent(storeId)}`;

  // 별점이 있는 리뷰만 평균 산정 (별점 0짜리 글리뷰가 평균을 끌어내리지 않도록)
  const rated = reviews.filter((r) => r.rating > 0);
  const avgRating = rated.length ? rated.reduce((s, r) => s + r.rating, 0) / rated.length : 0;

  const categories: Array<[string, SitePayload["menu"]]> = [];
  {
    const map = new Map<string, SitePayload["menu"]>();
    for (const m of menu) {
      const c = m.category || t("site.menu.fallbackCategory", lang);
      const bucket = map.get(c);
      if (bucket) bucket.push(m);
      else map.set(c, [m]);
    }
    categories.push(...map.entries());
  }

  const displayStyle = { fontFamily: "var(--site-display)" };

  return (
    <div
      className="min-h-screen bg-[#faf7f2] text-[#2b2622] antialiased"
      style={
        {
          "--site-display": siteFont.display,
          "--site-body": siteFont.body,
          fontFamily: "var(--site-body)",
        } as React.CSSProperties
      }
    >
      {/* ===== 상단 바 (스티키) ===== */}
      <nav className="sticky top-0 z-30 bg-[#faf7f2]/85 backdrop-blur border-b border-[#ece4d8]">
        <div className="max-w-[1080px] mx-auto px-5 h-14 flex items-center justify-between">
          <span className="text-[18px] tracking-tight text-[#2b2622]" style={displayStyle}>
            {store.name}
          </span>
          <div className="hidden sm:flex items-center gap-6 text-[13px] font-semibold text-[#6b6055]">
            <a href="#menu" className="hover:text-[#9a6b43] transition-colors">{t("site.nav.menu", lang)}</a>
            {reviews.length > 0 && (
              <a href="#reviews" className="hover:text-[#9a6b43] transition-colors">{t("site.nav.reviews", lang)}</a>
            )}
            <a href="#visit" className="hover:text-[#9a6b43] transition-colors">{t("site.nav.visit", lang)}</a>
          </div>
          <a
            href={orderHref}
            className="h-9 px-4 rounded-full bg-[#9a6b43] text-white text-[13px] font-bold inline-flex items-center hover:bg-[#85572f] transition-colors"
          >
            {t("site.nav.order", lang)}
          </a>
        </div>
      </nav>

      {/* ===== 히어로 ===== */}
      <header className="relative">
        <div className="relative h-[78vh] min-h-[460px] w-full overflow-hidden">
          {hero ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imgUrl(hero, storeId)} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[#e9ddcb] to-[#cbb79a]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/15 to-black/30" />
          <div className="relative h-full max-w-[1080px] mx-auto px-6 flex flex-col items-center justify-center text-center text-white">
            <p className="text-[12px] tracking-[0.35em] uppercase opacity-80 mb-4">Welcome</p>
            <h1 className="text-[40px] sm:text-[64px] leading-[1.05] tracking-tight drop-shadow-sm" style={displayStyle}>
              {store.name}
            </h1>
            {store.tagline && (
              <p className="mt-3 text-[15px] sm:text-[17px] text-white/90 font-medium tracking-wide">{store.tagline}</p>
            )}
            {store.temporarilyClosed ? (
              <span className="mt-5 px-4 py-1.5 rounded-full bg-white/90 text-[#9a3b2f] text-[13px] font-bold">
                {t("site.hero.tempClosed", lang)}
              </span>
            ) : (
              <a
                href={orderHref}
                className="mt-7 h-12 px-7 rounded-full bg-white text-[#2b2622] text-[14px] font-extrabold inline-flex items-center gap-2 hover:bg-[#f3ece1] transition-colors shadow-lg"
              >
                {t("site.hero.orderCta", lang)}
              </a>
            )}
            {avgRating > 0 && (
              <p className="mt-5 text-[13px] text-white/90 inline-flex items-center gap-1.5">
                <span className="text-[#ffd36b]">{"★".repeat(Math.round(avgRating))}</span>
                <span className="opacity-80">
                  {t("site.hero.ratingLine", lang, { rating: avgRating.toFixed(1), n: rated.length })}
                </span>
              </p>
            )}
          </div>
        </div>
      </header>

      {/* ===== 메뉴 ===== */}
      <section id="menu" className="max-w-[1080px] mx-auto px-6 py-20 sm:py-28 scroll-mt-16">
        <SectionTitle eyebrow="Our Menu" title={t("site.menu.title", lang)} />
        {categories.length === 0 ? (
          <p className="text-center text-[#8a7f74] py-10">{t("site.menu.empty", lang)}</p>
        ) : (
          <div className="space-y-16 mt-12">
            {categories.map(([cat, items]) => (
              <div key={cat}>
                <h3 className="text-[24px] text-[#2b2622] mb-6 pb-2 border-b border-[#e8ddcd]" style={displayStyle}>
                  {cat}
                </h3>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-7">
                  {items.map((m, i) => (
                    <article key={i} className="group">
                      <div className="aspect-[4/3] rounded-2xl overflow-hidden bg-[#efe7da] mb-3">
                        {m.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={m.imageUrl}
                            alt={m.name}
                            className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-500"
                          />
                        ) : (
                          <div
                            className="w-full h-full flex items-center justify-center text-[#c3b49d] text-[28px]"
                            style={displayStyle}
                          >
                            {m.name[0]}
                          </div>
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-2">
                        <h4 className="font-bold text-[15px] text-[#2b2622] truncate">{m.name}</h4>
                        <span className="text-[14px] font-extrabold text-[#9a6b43] tabular-nums shrink-0">
                          {fmtKRW(m.price, lang)}
                        </span>
                      </div>
                      {m.description && (
                        <p className="text-[12.5px] text-[#8a7f74] mt-1 leading-relaxed line-clamp-2">{m.description}</p>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== 리뷰 ===== */}
      {reviews.length > 0 && (
        <section id="reviews" className="bg-[#f3ebe0] py-20 sm:py-28 scroll-mt-16">
          <div className="max-w-[1080px] mx-auto px-6">
            <SectionTitle eyebrow="Reviews" title={t("site.reviews.title", lang)} />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-12">
              {reviews.map((r, i) => (
                <figure key={i} className="rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] flex flex-col">
                  {r.rating > 0 && (
                    <div className="text-[#f0a82e] text-[15px] mb-3">
                      {"★".repeat(Math.min(5, r.rating))}
                      <span className="text-[#e0d6c6]">{"★".repeat(5 - Math.min(5, r.rating))}</span>
                    </div>
                  )}
                  <blockquote className="text-[14px] text-[#3d3630] leading-relaxed flex-1">&quot;{r.text}&quot;</blockquote>
                  <figcaption className="mt-4 text-[12px] text-[#8a7f74] flex items-center justify-between">
                    <span className="font-bold text-[#6b6055]">{r.name}</span>
                    <span>{r.date}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ===== 방문 정보 ===== */}
      <section id="visit" className="max-w-[1080px] mx-auto px-6 py-20 sm:py-28 scroll-mt-16">
        <SectionTitle eyebrow="Visit Us" title={t("site.visit.title", lang)} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 mt-12">
          <div>
            <h3 className="text-[20px] mb-4" style={displayStyle}>{t("site.hours.title", lang)}</h3>
            {store.businessHours?.open24h ? (
              <p className="text-[15px] font-bold text-[#9a6b43]">{t("site.hours.open24h", lang)}</p>
            ) : store.businessHours?.weekly?.length ? (
              <ul className="space-y-2">
                {store.businessHours.weekly.slice(0, 7).map((w, i) => (
                  <li key={i} className="flex items-center justify-between text-[14px] border-b border-[#ece4d8] pb-2">
                    <span className="font-bold text-[#6b6055] w-8">{weekdayLabel(i, lang)}</span>
                    <span className={w?.closed ? "text-[#b6a892]" : "text-[#3d3630] font-semibold tabular-nums"}>
                      {w?.closed ? t("site.hours.closed", lang) : `${w?.open ?? "—"} – ${w?.close ?? "—"}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-[#8a7f74]">{t("site.hours.none", lang)}</p>
            )}
          </div>
          <div className="space-y-5">
            <h3 className="text-[20px] mb-1" style={displayStyle}>{t("site.contact.title", lang)}</h3>
            {store.address && (
              <a
                href={`https://map.kakao.com/?q=${encodeURIComponent(store.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-[14px] text-[#3d3630] leading-relaxed hover:text-[#9a6b43]"
              >
                📍 {store.address}
              </a>
            )}
            {store.phone && <a href={`tel:${store.phone}`} className="block text-[15px] font-bold text-[#9a6b43]">{store.phone}</a>}
            {store.instagram && (
              <a
                href={`https://instagram.com/${store.instagram}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-[14px] font-bold text-[#6b6055] hover:text-[#9a6b43]"
              >
                <span className="w-6 h-6 rounded-md bg-gradient-to-br from-[#f58529] to-[#dd2a7b]" />@{store.instagram}
              </a>
            )}
            <a
              href={orderHref}
              className="mt-2 h-12 px-6 rounded-full bg-[#9a6b43] text-white text-[14px] font-extrabold inline-flex items-center hover:bg-[#85572f] transition-colors"
            >
              {t("site.contact.orderNow", lang)}
            </a>
          </div>
        </div>
      </section>

      {/* ===== 푸터 ===== */}
      <footer className="bg-[#2b2622] text-[#cabfae] py-12">
        <div className="max-w-[1080px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-[18px] text-white" style={displayStyle}>{store.name}</span>
          <span className="text-[12px] text-[#8c8170]">{t("site.footer.madeBy", lang)}</span>
        </div>
      </footer>
    </div>
  );
}
